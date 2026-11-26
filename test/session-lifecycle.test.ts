import { env, SELF } from "./harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import { initDb, postForm, refreshCsrf, signUpAndLogIn, startSession } from "./helpers.js";

beforeAll(initDb);

describe("session lifecycle", () => {
	it("re-login in the same browser replaces the old session row instead of leaking it", async () => {
		const email = "mike@example.com";
		const password = "twelve-chars-ok";
		await signUpAndLogIn(email, password);
		const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
			.bind(email)
			.first<{ id: number }>();

		// Log in a second time through the SAME browser session (same cookie jar).
		const session = await startSession("/login");
		await postForm("/login", { email, password }, session);
		await refreshCsrf(session, "/");
		const relogin = await postForm("/login", { email, password }, session);
		expect(relogin.status).toBe(303);

		const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?")
			.bind(user!.id)
			.first<{ n: number }>();
		// One row from signUpAndLogIn + one from the session jar re-login.
		// The re-login must destroy the jar's first row, not orphan it.
		expect(rows!.n).toBe(2);
	});

	it("refreshes the session cookie on activity, not only on mutation", async () => {
		const session = await signUpAndLogIn("richel@example.com");
		const res = await SELF.fetch("http://example.com/", {
			headers: { cookie: session.cookie },
			redirect: "manual",
		});
		expect(res.status).toBe(200);
		const sessionCookies = res.headers
			.getSetCookie()
			.filter((cookie) => cookie.startsWith("cuota_session="));
		expect(sessionCookies.length).toBe(1);
		expect(sessionCookies[0]).toMatch(/Max-Age=\d+/);
	});
});
