import { Hono } from "hono";
import { hashPassword, passwordLongEnough } from "../auth.js";
import type { AppEnv } from "../app-env.js";
import { createUserWithinLimit, UserLimitReachedError } from "../db.js";
import { claimSetupSlot, readSetupInput, releaseSetup, userCount, type ClaimOutcome } from "../setup.js";
import type { SqlDatabase } from "../ports.js";
import { renderView } from "../views.js";

const MIN_PASSWORD_MESSAGE = "Password must be at least 12 characters.";
const NAME_MESSAGE = "Enter the name you want on the dashboard.";
const EMAIL_MESSAGE = "Enter an email address.";
const TAKEN_MESSAGE = "That email already has an account. Sign in instead.";

const app = new Hono<AppEnv>();

/** Locals every render of the setup page needs. */
function setupLocals(csrfToken: string, extra: Record<string, unknown> = {}) {
	return {
		title: "Set up",
		csrfToken,
		tokenRequired: false,
		...extra,
	};
}

app.get("/setup", async (c) => {
	if ((await userCount(c.get("db"))) > 0) return c.redirect("/login", 303);

	const tokenRequired = Boolean(c.get("config").setupToken);
	return c.html(renderView("setup", setupLocals(c.get("csrfToken"), { tokenRequired })));
});

app.post("/setup", async (c) => {
	const db = c.get("db");
	const config = c.get("config");

	// The page is dead the moment an account exists. Checked before parsing so a
	// stale form cannot create anything either.
	if ((await userCount(db)) > 0) return c.redirect("/login", 303);

	const input = readSetupInput(await c.req.parseBody());
	const tokenRequired = Boolean(config.setupToken);

	const renderError = (error: string, status: 400 | 403 | 409) =>
		c.html(
			renderView(
				"setup",
				setupLocals(c.get("csrfToken"), {
					tokenRequired,
					error,
					values: { email: input.email, name: input.name },
				}),
			),
			status,
		);

	if (input.token.length > 0 || tokenRequired) {
		// Constant-time is overkill here: the token is compared locally, and a
		// wrong answer only delays setup.
		if (!config.setupToken || input.token !== config.setupToken) {
			return renderError("That setup token is not right.", 403);
		}
	}
	if (input.name.length === 0) return renderError(NAME_MESSAGE, 400);
	if (input.email.length === 0) return renderError(EMAIL_MESSAGE, 400);
	if (!passwordLongEnough(input.password)) return renderError(MIN_PASSWORD_MESSAGE, 400);

	// One winner, decided by the database. Where the engine can roll back, the
	// claim and the account commit together; where it cannot, the claim carries
	// its instant so a dead attempt can be taken over after the TTL.
	const passwordHash = await hashPassword(input.password);

	const attempt = async (
		tx: SqlDatabase,
	): Promise<{ ok: true; id: number } | { ok: false; outcome: ClaimOutcome }> => {
		const outcome = await claimSetupSlot(tx, await tx.now());
		if (outcome === "in-progress") return { ok: false, outcome };
		const id = await createUserWithinLimit(tx, { email: input.email, name: input.name, passwordHash });
		return { ok: true, id };
	};

	let result: Awaited<ReturnType<typeof attempt>>;
	try {
		result = db.withTransaction ? await db.withTransaction(attempt) : await attempt(db);
	} catch (error) {
		// A transient failure must not leave the deployment unsettable: drop the
		// claim and let the operator try again.
		await releaseSetup(db).catch(() => {});
		// A signup that won the race filled the household between the pre-check
		// above and this insert; the limit, not a duplicate, is the truth.
		if (error instanceof UserLimitReachedError) {
			return renderError("Cuota already has two accounts. Sign in instead.", 409);
		}
		if (String(error).includes("UNIQUE") || String(error).includes("duplicate key")) {
			return renderError(TAKEN_MESSAGE, 400);
		}
		throw error;
	}

	if (!result.ok) {
		// Someone else is mid-submission. If their account landed in the
		// meantime, sending this one to login is the truth.
		if ((await userCount(db)) > 0) return c.redirect("/login", 303);
		return renderError("Setup is already in progress. Try again in a moment.", 409);
	}

	console.info("first account created", { userId: result.id });
	return c.redirect("/login", 303);
});

export default app;