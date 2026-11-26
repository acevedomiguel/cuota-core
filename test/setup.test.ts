import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCuotaApp } from "../src/app.js";
import { app, database, env, testConfig } from "./harness.js";
import { initDb, postForm, startSession } from "./helpers.js";

/**
 * First-run setup: a fresh database has no accounts and no allowlist, so the
 * app must offer exactly one account and then close the door for good.
 */

const NOT_ALLOWED = "owner@example.com";

async function userCount(): Promise<number> {
	const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
	return Number(row?.n ?? 0);
}

/** Empties every table the gate touches, keeping the schema. */
async function reset(): Promise<void> {
	await env.DB.prepare("DELETE FROM sessions").run();
	await env.DB.prepare("DELETE FROM passkey_credentials").run();
	await env.DB.prepare("DELETE FROM users").run();
	await env.DB.prepare("DELETE FROM settings").run();
}

beforeAll(initDb);
beforeEach(reset);

describe("first run", () => {
	it("sends a fresh deployment to setup instead of a login nobody can pass", async () => {
		expect(await userCount()).toBe(0);

		for (const path of ["/", "/login", "/signup"]) {
			const res = await app.request(`http://example.com${path}`, { redirect: "manual" });
			expect(res.status).toBe(303);
			expect(res.headers.get("location")).toBe("/setup");
		}

		const setup = await app.request("http://example.com/setup", { redirect: "manual" });
		expect(setup.status).toBe(200);
		const html = await setup.text();
		expect(html).toContain('action="/setup"');
		expect(html).toContain('name="_csrf"');
		expect(html).toContain('name="password"');
	});

	it("creates the first account without an invitation", async () => {
		const res = await postForm("/setup", {
			name: "Owner",
			email: NOT_ALLOWED,
			password: "twelve-chars-ok",
		});

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/login");
		expect(await userCount()).toBe(1);

		const row = await env.DB.prepare("SELECT email, name FROM users").first<{ email: string; name: string }>();
		expect(row?.email).toBe(NOT_ALLOWED);
		expect(row?.name).toBe("Owner");

		// The first account was never on the allowlist; the bypass is the point.
		expect(testConfig.allowedEmails).not.toContain(NOT_ALLOWED);
	});

	it("locks setup the moment one account exists", async () => {
		// One session, so the second attempt has a valid CSRF token even though
		// the page itself is already closed.
		const session = await startSession("/setup");
		await postForm("/setup", { name: "Owner", email: NOT_ALLOWED, password: "twelve-chars-ok" }, session);
		expect(await userCount()).toBe(1);

		const page = await app.request("http://example.com/setup", { redirect: "manual" });
		expect(page.status).toBe(303);
		expect(page.headers.get("location")).toBe("/login");

		const again = await postForm(
			"/setup",
			{ name: "Intruder", email: "intruder@example.com", password: "twelve-chars-ok" },
			session,
		);
		expect(again.status).toBe(303);
		expect(again.headers.get("location")).toBe("/login");
		expect(await userCount()).toBe(1);
	});

	it("requires the CSRF token like every other POST", async () => {
		const session = await startSession("/setup");
		const res = await app.request("http://example.com/setup", {
			method: "POST",
			redirect: "manual",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				cookie: session.cookie,
			},
			body: new URLSearchParams({ name: "Owner", email: NOT_ALLOWED, password: "twelve-chars-ok" }),
		});

		expect(res.status).toBe(403);
		expect(await userCount()).toBe(0);
	});

	it("creates exactly one account when two submissions race", async () => {
		// Each submission needs its own session and token.
		const first = await startSession("/setup");
		const second = await startSession("/setup");

		const submit = (session: typeof first, email: string) =>
			app.request("http://example.com/setup", {
				method: "POST",
				redirect: "manual",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					cookie: session.cookie,
				},
				body: new URLSearchParams({
					_csrf: session.csrf,
					name: email.split("@")[0],
					email,
					password: "twelve-chars-ok",
				}),
			});

		const [a, b] = await Promise.all([submit(first, "one@example.com"), submit(second, "two@example.com")]);

		// One wins and lands on login. The loser is told setup is in progress —
		// a 409, not a second account.
		expect([a.status, b.status]).toContain(303);
		for (const status of [a.status, b.status]) expect([303, 409]).toContain(status);
		expect(await userCount()).toBe(1);
	});

	it("takes over a claim left behind by an attempt that died", async () => {
		// The claim is written before the account. If the process dies in
		// between — an evicted Worker, a dropped connection — the row is still
		// there with no account beside it. Without a takeover, the deployment
		// could never be set up at all.
		const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
		await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('setup_claim', ?)").bind(stale).run();

		const res = await postForm("/setup", {
			name: "Owner",
			email: NOT_ALLOWED,
			password: "twelve-chars-ok",
		});

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/login");
		expect(await userCount()).toBe(1);
	});

	it("refuses while another submission is genuinely in flight", async () => {
		const fresh = new Date().toISOString();
		await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('setup_claim', ?)").bind(fresh).run();

		const res = await postForm("/setup", {
			name: "Second",
			email: "second@example.com",
			password: "twelve-chars-ok",
		});

		expect(res.status).toBe(409);
		expect(await userCount()).toBe(0);
	});

	it("sends a stale claim to login once accounts exist", async () => {
		// One session, so the second attempt carries a valid CSRF token even
		// though the page is already closed.
		const session = await startSession("/setup");
		await postForm("/setup", { name: "Owner", email: NOT_ALLOWED, password: "twelve-chars-ok" }, session);

		const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
		await env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'setup_claim'").bind(stale).run();

		const res = await postForm(
			"/setup",
			{ name: "Intruder", email: "intruder@example.com", password: "twelve-chars-ok" },
			session,
		);

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/login");
		expect(await userCount()).toBe(1);
	});

	it("still requires an invitation for the second account", async () => {
		await postForm("/setup", { name: "Owner", email: NOT_ALLOWED, password: "twelve-chars-ok" });

		const refused = await postForm("/signup", {
			name: "Stranger",
			email: "stranger@example.com",
			password: "twelve-chars-ok",
		});
		expect(refused.status).toBe(403);

		const allowed = await postForm("/signup", {
			name: "Partner",
			email: testConfig.allowedEmails[0],
			password: "twelve-chars-ok",
		});
		expect(allowed.status).toBe(303);
		expect(await userCount()).toBe(2);
	});
});

describe("setup token", () => {
	const guarded = createCuotaApp({
		database,
		config: { ...testConfig, setupToken: "s3cret-token" },
		assets: { fetch: () => new Response("asset") },
	});

	it("asks for the token and refuses a wrong or missing one", async () => {
		const page = await guarded.request("http://example.com/setup", { redirect: "manual" });
		const html = await page.text();
		expect(html).toContain('name="token"');

		const session = await startSession("/setup");
		const withoutToken = await guarded.request("http://example.com/setup", {
			method: "POST",
			redirect: "manual",
			headers: { "content-type": "application/x-www-form-urlencoded", cookie: session.cookie },
			body: new URLSearchParams({ _csrf: session.csrf, name: "Owner", email: NOT_ALLOWED, password: "twelve-chars-ok" }),
		});
		expect(withoutToken.status).toBe(403);
		expect(await userCount()).toBe(0);
	});

	it("accepts the right token", async () => {
		const session = await startSession("/setup");
		const res = await guarded.request("http://example.com/setup", {
			method: "POST",
			redirect: "manual",
			headers: { "content-type": "application/x-www-form-urlencoded", cookie: session.cookie },
			body: new URLSearchParams({
				_csrf: session.csrf,
				name: "Owner",
				email: NOT_ALLOWED,
				password: "twelve-chars-ok",
				token: "s3cret-token",
			}),
		});

		expect(res.status).toBe(303);
		expect(await userCount()).toBe(1);
	});
});