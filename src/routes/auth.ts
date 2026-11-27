import { Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import {
	createUserWithinLimit,
	destroyDbSession,
	getUserByEmail,
	UserLimitReachedError,
} from "../db.js";
import {
	emailTaken,
	establishAuthenticatedSession,
	hashPassword,
	isEmailAllowed,
	normalizeEmail,
	passwordLongEnough,
	verifyPassword,
} from "../auth.js";
import { renderView } from "../views.js";

const LOGIN_ERROR = "Sign in failed. Check your email and password and try again.";
const MIN_PASSWORD_MESSAGE = "Password must be at least 12 characters.";
const INVITATION_MESSAGE = "Cuota is invitation only. Ask for an invite, then try again.";
const LIMIT_MESSAGE = "Cuota is for two people, and both accounts are taken.";

const app = new Hono<AppEnv>();

app.get("/signup", (c) => {
	return c.html(renderView("signup", { title: "Create account", csrfToken: c.get("csrfToken") }));
});

app.post("/signup", async (c) => {
	const body = await c.req.parseBody();
	const email = normalizeEmail(String(body.email ?? ""));
	const name = String(body.name ?? "").trim();
	const password = String(body.password ?? "");

	const renderError = (error: string, status: 400 | 403) =>
		c.html(
			renderView("signup", {
				title: "Create account",
				error,
				csrfToken: c.get("csrfToken"),
				values: { email, name },
			}),
			status,
		);

	if (!isEmailAllowed(c.get("config"), email)) return renderError(INVITATION_MESSAGE, 403);
	if (!passwordLongEnough(password)) return renderError(MIN_PASSWORD_MESSAGE, 400);
	if (await emailTaken(c.get("db"), email)) {
		return renderError("That email already has an account. Sign in instead.", 400);
	}

	try {
		await createUserWithinLimit(c.get("db"), { email, name, passwordHash: await hashPassword(password) });
	} catch (error) {
		// The household is full. The limit is decided by the database — under a
		// lock where the engine has transactions — so two signups racing past the
		// page cannot both become the second account.
		if (error instanceof UserLimitReachedError) return renderError(LIMIT_MESSAGE, 403);
		throw error;
	}
	return c.redirect("/login", 303);
});

app.get("/login", (c) => {
	return c.html(renderView("login", { title: "Sign in", csrfToken: c.get("csrfToken") }));
});

app.post("/login", async (c) => {
	const body = await c.req.parseBody();
	const email = normalizeEmail(String(body.email ?? ""));
	const password = String(body.password ?? "");

	const user = await getUserByEmail(c.get("db"), email);
	const valid = user !== null && (await verifyPassword(password, user.password_hash));
	if (!valid || !user) {
		return c.html(
			renderView("login", {
				title: "Sign in",
				error: LOGIN_ERROR,
				csrfToken: c.get("csrfToken"),
				values: { email },
			}),
			401,
		);
	}

	await establishAuthenticatedSession(c.get("db"), c.get("session"), user.id);
	return c.redirect("/", 303);
});

app.post("/logout", async (c) => {
	const session = c.get("session");
	const sessionId = session.get<string>("sessionId");
	if (typeof sessionId === "string") await destroyDbSession(c.get("db"), sessionId);
	session.destroy();
	return c.redirect("/login", 303);
});

export default app;
