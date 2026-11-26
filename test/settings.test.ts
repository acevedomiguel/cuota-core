import { env, SELF } from "./harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import { initDb, getPage, postForm, postJson, refreshCsrf, signUpAndLogIn, startSession } from "./helpers.js";
import type { FormSession } from "./helpers.js";
import { getUserByEmail, updatePasswordHash } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { getPasskeyById, savePasskeyCredential } from "../src/passkeys.js";
import type { PasskeyCredential } from "../src/passkeys.js";

const MIKE = "mike@example.com";
const RICHEL = "richel@example.com";

beforeAll(initDb);

/** Seeds a stored credential for `userId` without running a WebAuthn ceremony. */
async function seedPasskey(
	userId: number,
	id: string,
	name: string,
	overrides: Partial<PasskeyCredential> = {},
): Promise<PasskeyCredential> {
	const credential: PasskeyCredential = {
		id,
		userId,
		publicKey: "cHVibGljLWtleQ",
		credentialType: "public-key",
		deviceType: "singleDevice",
		backedUp: false,
		aaguid: "00000000-0000-0000-0000-000000000000",
		name,
		transports: ["internal"],
		counter: 0,
		createdAt: "2026-11-01T00:00:00.000Z",
		lastUsedAt: null,
		...overrides,
	};
	await savePasskeyCredential(env.DB, credential);
	return credential;
}

async function userIdOf(email: string): Promise<number> {
	const user = await getUserByEmail(env.DB, email);
	if (!user) throw new Error(`no user for ${email}`);
	return user.id;
}

describe("settings page", () => {
	it("lists my passkeys with name, created and last-used dates", async () => {
		const session = await signUpAndLogIn(MIKE, "twelve-chars-ok", "Mike");
		await seedPasskey(await userIdOf(MIKE), "mike-cred-a", "Mike's iPhone", {
			createdAt: "2026-11-01T00:00:00.000Z",
			lastUsedAt: "2026-11-20T09:30:00.000Z",
		});
		await seedPasskey(await userIdOf(MIKE), "mike-cred-b", "YubiKey", {
			createdAt: "2026-11-02T00:00:00.000Z",
			lastUsedAt: null,
		});

		const html = await getPage(session, "/settings");

		// Anchor first: a 404 body would make every negative assertion vacuous.
		expect(html).toContain(">Passkeys<");
		expect(html).toContain("Mike&#39;s iPhone");
		expect(html).toContain("YubiKey");
		expect(html).toContain("2026-11-01");
		expect(html).toContain("2026-11-20");
		// A credential never used since registration says so rather than
		// rendering an empty cell.
		expect(html).toContain("Never used");
	});

	it("never shows the other user's passkeys", async () => {
		const session = await signUpAndLogIn(MIKE, "twelve-chars-ok", "Mike");
		await signUpAndLogIn(RICHEL, "twelve-chars-ok", "Richel");
		await seedPasskey(await userIdOf(RICHEL), "richel-cred-a", "Richel's MacBook");

		const html = await getPage(session, "/settings");

		expect(html).toContain(">Passkeys<");
		expect(html).not.toContain("Richel&#39;s MacBook");
	});

	it("delete removes my passkey and keeps my session alive", async () => {
		const session = await signUpAndLogIn(MIKE, "twelve-chars-ok", "Mike");
		await seedPasskey(await userIdOf(MIKE), "mike-cred-delete", "Old phone");

		const res = await postForm("/settings/passkeys/mike-cred-delete/delete", {}, session);

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/settings");
		// The password fallback means deleting the last passkey is allowed, and
		// it must not tear down the session the deletion came from.
		const home = await SELF.fetch("http://example.com/", {
			headers: { cookie: session.cookie },
			redirect: "manual",
		});
		expect(home.status).toBe(200);
		expect(await getPage(session, "/settings")).not.toContain("Old phone");
		expect(await getPasskeyById(env.DB, "mike-cred-delete")).toBeNull();
	});

	it("deleting the other user's passkey id returns 404 and removes nothing", async () => {
		const session = await signUpAndLogIn(MIKE, "twelve-chars-ok", "Mike");
		await signUpAndLogIn(RICHEL, "twelve-chars-ok", "Richel");
		const hers = await seedPasskey(await userIdOf(RICHEL), "richel-cred-delete", "Richel's phone");

		const res = await postForm("/settings/passkeys/richel-cred-delete/delete", {}, session);

		expect(res.status).toBe(404);
		expect(await getPasskeyById(env.DB, hers.id)).not.toBeNull();
	});

	it("deleting an unknown passkey id is a no-op redirect, not an error", async () => {
		const session = await signUpAndLogIn(MIKE, "twelve-chars-ok", "Mike");

		const res = await postForm("/settings/passkeys/never-existed/delete", {}, session);

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/settings");
	});

	it("register options still work from the settings page (existing routes unchanged)", async () => {
		const session = await signUpAndLogIn(MIKE, "twelve-chars-ok", "Mike");

		const res = await postJson("/passkeys/register/options", {}, session);

		expect(res.status).toBe(200);
		const body = (await res.json()) as { challenge: string };
		expect(body.challenge).toBeTruthy();
	});

	it("wires the vendored passkey client so a passkey can be added here", async () => {
		const session = await signUpAndLogIn(MIKE, "twelve-chars-ok", "Mike");

		const html = await getPage(session, "/settings");

		expect(html).toContain(">Passkeys<");
		expect(html).toContain("/static/passkeys.js");
		expect(html).toContain('id="passkeyRegisterButton"');
	});
});

/** Signs in as `email` with `password`, returning the POST /login status. */
async function loginStatus(email: string, password: string): Promise<number> {
	const session = await startSession("/login");
	return (await postForm("/login", { email, password }, session)).status;
}

/**
 * Forces Richel's password to a known value and returns a signed-in session.
 * The tests in this block each change the stored hash, and miniflare keeps one
 * D1 instance per test *file*, so every test resets the hash rather than
 * depending on what an earlier test left behind.
 */
async function richelSession(password = "twelve-chars-ok"): Promise<FormSession> {
	await postForm("/signup", { email: RICHEL, name: "Richel", password });
	const user = await getUserByEmail(env.DB, RICHEL);
	if (!user) throw new Error(`no user for ${RICHEL}`);
	await updatePasswordHash(env.DB, user.id, await hashPassword(password));

	const session = await startSession("/login");
	const login = await postForm("/login", { email: RICHEL, password }, session);
	if (login.status !== 303) throw new Error(`login failed: ${login.status}`);
	await refreshCsrf(session, "/settings");
	return session;
}

async function storedHash(email: string): Promise<string> {
	const user = await getUserByEmail(env.DB, email);
	if (!user) throw new Error(`no user for ${email}`);
	return user.password_hash;
}

describe("change password", () => {
	it("changes the password with the correct current password", async () => {
		const session = await richelSession("twelve-chars-ok");

		const res = await postForm(
			"/settings/password",
			{ current: "twelve-chars-ok", next: "new-twelve-chars" },
			session,
		);

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/settings");
		expect(await loginStatus(RICHEL, "twelve-chars-ok")).toBe(401);
		expect(await loginStatus(RICHEL, "new-twelve-chars")).toBe(303);
	});

	it("rejects a wrong current password and keeps the old one", async () => {
		const session = await richelSession("twelve-chars-ok");

		const res = await postForm(
			"/settings/password",
			{ current: "not-my-password", next: "new-twelve-chars" },
			session,
		);

		expect(res.status).toBe(422);
		expect(await res.text()).toContain("Current password is wrong");
		// A hijacked session must not be enough to take the account over.
		expect(await loginStatus(RICHEL, "twelve-chars-ok")).toBe(303);
		expect(await loginStatus(RICHEL, "new-twelve-chars")).toBe(401);
	});

	it("rejects a next password under 12 chars", async () => {
		const session = await richelSession("twelve-chars-ok");
		const before = await storedHash(RICHEL);

		const res = await postForm("/settings/password", { current: "twelve-chars-ok", next: "elevenchars" }, session);

		expect(res.status).toBe(422);
		expect(await res.text()).toContain("at least 12 characters");
		expect(await storedHash(RICHEL)).toBe(before);
	});

	it("keeps the session valid after a successful change", async () => {
		const session = await richelSession("twelve-chars-ok");

		const res = await postForm(
			"/settings/password",
			{ current: "twelve-chars-ok", next: "new-twelve-chars" },
			session,
		);
		expect(res.status).toBe(303);

		// No surprise logout: changing the password does not touch the session row.
		const home = await SELF.fetch("http://example.com/", {
			headers: { cookie: session.cookie },
			redirect: "manual",
		});
		expect(home.status).toBe(200);
	});
});
