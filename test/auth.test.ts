import { env, SELF, testConfig } from "./harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import { createUser, getUserByEmail } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { initDb, postForm, startSession } from "./helpers.js";

const PASSWORD = "correct-horse-123";

/** Emails from the configured allowlist, in order. */
function allowedEmails(): string[] {
	return testConfig.allowedEmails.map((entry) => entry.trim()).filter(Boolean);
}

function firstAllowedEmail(): string {
	return allowedEmails()[0] ?? "";
}

beforeAll(async () => {
	await initDb();
	await createUser(env.DB, {
		email: "a@example.com",
		name: "A",
		passwordHash: await hashPassword(PASSWORD),
	});
});

describe("signup", () => {
	it("rejects signup for emails not on the allowlist", async () => {
		const res = await postForm("/signup", { email: "stranger@example.com", name: "X", password: "twelve-chars-ok" });
		expect(res.status).toBe(403);
		expect(await res.text()).toContain("invitation");
	});

	it("matches the allowlist case-insensitively and trims whitespace", async () => {
		const email = firstAllowedEmail();
		expect(email).toBeTruthy();
		const res = await postForm("/signup", {
			email: ` ${email.toUpperCase()} `,
			name: "Test",
			password: "twelve-chars-ok",
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/login");
		// stored normalised, so login can find it
		expect(await getUserByEmail(env.DB, email.toLowerCase())).not.toBeNull();
	});

	it("rejects a duplicate email instead of crashing", async () => {
		const email = allowedEmails()[1] ?? allowedEmails()[0] ?? "";
		expect(email).toBeTruthy();
		await createUser(env.DB, { email, name: "Taken", passwordHash: "pbkdf2:100000:AAAA:BBBB" });
		const res = await postForm("/signup", { email, name: "Clone", password: "twelve-chars-ok" });
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("already");
	});

	it("rejects passwords shorter than 12 characters", async () => {
		const res = await postForm("/signup", {
			email: firstAllowedEmail(),
			name: "Short",
			password: "eleven-char",
		});
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("12");
	});
});

describe("login", () => {
	it("logs in with valid credentials and rejects bad passwords", async () => {
		const session = await startSession("/login");
		const login = await postForm("/login", { email: "a@example.com", password: PASSWORD }, session);
		expect(login.status).toBe(303);
		expect(login.headers.get("location")).toBe("/");
		const setCookie = login.headers.getSetCookie().join("; ");
		expect(setCookie).toContain("cuota_session=");

		const bad = await postForm("/login", { email: "a@example.com", password: "wrong-horse-123" }, await startSession("/login"));
		expect(bad.status).toBe(401);
	});

	it("rejects an unknown email without revealing whether it exists", async () => {
		const res = await postForm("/login", { email: "ghost@example.com", password: PASSWORD });
		expect(res.status).toBe(401);
		expect(await res.text()).toContain("Sign in failed");
	});

	it("rejects POST without a valid CSRF token with 403", async () => {
		const res = await SELF.fetch("http://example.com/login", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ email: "a@example.com", password: "x" }),
			redirect: "manual",
		});
		expect(res.status).toBe(403);
		expect(await res.text()).toContain("Session expired");
	});

	it("rejects a JSON POST with no CSRF token with 403", async () => {
		// The JSON branch of the CSRF middleware reads `_csrf` from the parsed
		// body; a request without it must fail the same way a form does.
		const res = await SELF.fetch("http://example.com/login/passkey/options", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
			redirect: "manual",
		});
		expect(res.status).toBe(403);
		expect(await res.text()).toContain("Session expired");
	});

	it("rejects a JSON POST with a malformed body with 403, not 500", async () => {
		const res = await SELF.fetch("http://example.com/login/passkey/options", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "not json",
			redirect: "manual",
		});
		expect(res.status).toBe(403);
	});
});

describe("auth gate", () => {
	it("redirects unauthenticated requests for protected pages to /login", async () => {
		const res = await SELF.fetch("http://example.com/", { redirect: "manual" });
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/login");
	});

	it("serves protected pages to a signed-in session", async () => {
		const login = await postForm("/login", { email: "a@example.com", password: PASSWORD });
		const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
		const res = await SELF.fetch("http://example.com/", { headers: { cookie } });
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("cuota");
	});

	it("rejects a tampered session cookie", async () => {
		const login = await postForm("/login", { email: "a@example.com", password: PASSWORD });
		const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
		const forged = cookie.slice(0, -3) + "abc";
		const res = await SELF.fetch("http://example.com/", {
			headers: { cookie: forged },
			redirect: "manual",
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/login");
	});
});

describe("logout", () => {
	it("destroys the session server-side", async () => {
		const login = await postForm("/login", { email: "a@example.com", password: PASSWORD });
		const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
		const home = await SELF.fetch("http://example.com/", { headers: { cookie } });
		const csrf = (await home.text()).match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";

		const logout = await SELF.fetch("http://example.com/logout", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", cookie },
			body: new URLSearchParams({ _csrf: csrf }),
			redirect: "manual",
		});
		expect(logout.status).toBe(303);

		const after = await SELF.fetch("http://example.com/", { headers: { cookie }, redirect: "manual" });
		expect(after.status).toBe(303);
	});
});

describe("concurrent sessions", () => {
	it("keeps user A signed in when user B signs in", async () => {
		await createUser(env.DB, {
			email: "b@example.com",
			name: "B",
			passwordHash: await hashPassword(PASSWORD),
		});

		const loginA = await postForm("/login", { email: "a@example.com", password: PASSWORD });
		const cookieA = loginA.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
		expect((await SELF.fetch("http://example.com/", { headers: { cookie: cookieA } })).status).toBe(200);

		const loginB = await postForm("/login", { email: "b@example.com", password: PASSWORD });
		const cookieB = loginB.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
		expect((await SELF.fetch("http://example.com/", { headers: { cookie: cookieB } })).status).toBe(200);

		// B's login must not invalidate A's session
		expect((await SELF.fetch("http://example.com/", { headers: { cookie: cookieA } })).status).toBe(200);
	});
});
