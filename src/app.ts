import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "./app-env.js";
import { currentUser, ensureCsrfToken, validCsrfToken } from "./auth.js";
import { userCount } from "./setup.js";
import type { AppConfig } from "./config.js";
import { buildHome } from "./home.js";
import { pruneReceipts, receiptCutoff, retentionEnabled } from "./receipts.js";
import type { AssetHandler, ReceiptStore, SqlDatabase } from "./ports.js";
import { renderView } from "./views.js";
import { sessionMiddleware } from "./session.js";
import aboutRoutes from "./routes/about.js";
import analyticsRoutes from "./routes/analytics.js";
import authRoutes from "./routes/auth.js";
import expenseRoutes from "./routes/expenses.js";
import exportRoutes from "./routes/export.js";
import incomeRoutes from "./routes/incomes.js";
import openingRoutes from "./routes/opening.js";
import passkeyRoutes from "./routes/passkeys.js";
import receiptRoutes from "./routes/receipts.js";
import scanRoutes, { MAX_UPLOAD_BYTES, OVERSIZE_MESSAGE, scanLocals } from "./routes/scan.js";
import settingsRoutes from "./routes/settings.js";
import setupRoutes from "./routes/setup.js";

export interface CuotaAppOptions {
	/** Where the ledger lives. The host supplies the driver. */
	database: SqlDatabase;
	/** Deployment decisions: allowlist, passkeys, optional features. */
	config: AppConfig;
	/** Serves `/static/*`; a binding, a directory, or an in-memory map. */
	assets: AssetHandler;
	/**
	 * Where receipt photos are kept. Optional: without it the app simply cannot
	 * attach or serve one, and every other page works as normal.
	 */
	receipts?: ReceiptStore;
	/**
	 * How long a receipt photo stays linked, in days. Optional: without it a
	 * stored receipt is linked indefinitely. Past the window the photo stops
	 * being offered, though its row remains until something deletes it.
	 */
	receiptRetentionDays?: number;
	/** Mount extra routes before the auth gate, e.g. a health or metadata
	 * endpoint that must answer without a session. They see the database,
	 * config, and assets on the context but no session or user, so everything
	 * mounted here is public: do not put pages behind it. */
	hostRoutes?: (app: Hono<AppEnv>) => void;
}

/**
 * Builds the application. Everything the app needs is passed in, so the same
 * build serves a container, a serverless runtime, or a test with no changes:
 * only the three ports differ between hosts.
 */
export function createCuotaApp({ database, config, assets, receipts, receiptRetentionDays, hostRoutes }: CuotaAppOptions): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	app.use(async (c, next) => {
		c.set("db", database);
		c.set("config", config);
		c.set("assets", assets);
		c.set("receipts", receipts);
		c.set("receiptRetentionDays", receiptRetentionDays);
		await next();
	});

	app.all("/static/*", (c) => {
		const url = new URL(c.req.url);
		url.pathname = url.pathname.replace(/^\/static/, "") || "/";
		return c.get("assets").fetch(new Request(url.toString(), c.req.raw));
	});

	// Host routes live here, before the auth gate, so a health check or a
	// metadata endpoint can answer without a session. Everything a normal page
	// needs is already on the context.
	hostRoutes?.(app);

	app.use(sessionMiddleware);

	app.use(async (c, next) => {
		c.set("csrfToken", ensureCsrfToken(c.get("session")));
		await next();
	});

	const PUBLIC_PATHS = ["/login", "/signup", "/setup"];
	const PUBLIC_PREFIXES = ["/login/passkey/"];

	function isPublic(path: string): boolean {
		return PUBLIC_PATHS.includes(path) || PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
	}

	// Route registration order matters: /setup must exist before the gate
	// decides whether the database is empty.
	app.use(async (c, next) => {
		const path = c.req.path;
		const user = await currentUser(c.get("db"), c.get("session"));

		if (user && path === "/login" && c.req.method === "GET") return c.redirect("/", 303);

		if (!user) {
			// A fresh deployment has nobody to sign in as, so every page goes to
			// setup until the first account exists. One count, only for callers
			// with no session.
			if (path !== "/setup" && (await userCount(c.get("db"))) === 0) return c.redirect("/setup", 303);
			if (!isPublic(path)) return c.redirect("/login", 303);
		}

		c.set("user", user);
		await next();
	});

	// Cap the scan upload *before* the CSRF middleware parses the multipart
	// body. Without this, an oversized photo is fully buffered before the
	// route's own size check runs, which is exactly what that check prevents.
	app.use(
		"/scan",
		bodyLimit({
			maxSize: MAX_UPLOAD_BYTES,
			onError: (c) => c.html(renderView("scan", scanLocals(c.get("csrfToken"), OVERSIZE_MESSAGE)), 422),
		}),
	);

	app.use(async (c, next) => {
		if (c.req.method !== "POST") return next();
		const contentType = c.req.header("content-type") ?? "";
		let candidate: unknown;
		try {
			candidate = contentType.includes("json")
				? ((await c.req.json()) as Record<string, unknown>)._csrf
				: (await c.req.parseBody())["_csrf"];
		} catch {
			candidate = undefined;
		}
		if (!validCsrfToken(c.get("session"), candidate)) {
			const user = await currentUser(c.get("db"), c.get("session"));
			return c.html(renderView("error", { title: "Session expired", authenticated: user !== null }), 403);
		}
		await next();
	});

	app.get("/", async (c) => {
		// The auth gate has already resolved the session into c.get("user") and
		// redirected signed-out requests to /login; this is only belt-and-braces.
		const user = c.get("user");
		if (!user) return c.redirect("/login", 303);

		// Receipts past the retention window are swept as the list is drawn: one
		// best-effort statement, so a failure never breaks the page. The same
		// cutoff hides them even if the delete did not run, and the store's own
		// rule (a bucket lifecycle, say) expires the bytes. The cutoff comes from
		// the database clock, like every other timestamp.
		let receiptsNotBefore: string | undefined;
		if (retentionEnabled(receiptRetentionDays)) {
			receiptsNotBefore = receiptCutoff(receiptRetentionDays, new Date(await c.get("db").now()));
			if (c.get("receipts")) {
				await pruneReceipts(c.get("db"), receiptsNotBefore).catch((error) => {
					console.warn("could not sweep expired receipts", error);
				});
			}
		}

		const view = await buildHome(c.get("db"), user.id, receiptsNotBefore);
		return c.html(
			renderView("home", {
				...view,
				title: "Cuota",
				authenticated: true,
				csrfToken: c.get("csrfToken"),
				user: { name: user.name, email: user.email },
			}),
		);
	});

	app.route("/", aboutRoutes);
	app.route("/", analyticsRoutes);
	app.route("/", authRoutes);
	app.route("/", expenseRoutes);
	app.route("/", exportRoutes);
	app.route("/", incomeRoutes);
	app.route("/", openingRoutes);
	app.route("/", passkeyRoutes);
	app.route("/", receiptRoutes);
	app.route("/", scanRoutes);
	app.route("/", settingsRoutes);
	app.route("/", setupRoutes);

	return app;
}