import { env, SELF, testConfig } from "./harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import { initDb, postJson, signUpAndLogIn, startSession } from "./helpers.js";
import {
	consumePasskeyChallenge,
	getPasskeyById,
	issuePasskeyChallenge,
	listPasskeysByUser,
	passkeyConfig,
	savePasskeyCredential,
	updatePasskeyCounter,
} from "../src/passkeys.js";
import type { AppConfig } from "../src/config.js";
import type { Session } from "../src/ports.js";

/** A config carrying only passkey settings, for the validator's own tests. */
function passkeyOnly(passkeys: AppConfig["passkeys"]): AppConfig {
	return { allowedEmails: [], passkeys, version: "test" };
}

/** A minimal in-memory Session for the challenge helpers, which never touch D1. */
function fakeSession(): Session {
	const entries = new Map<string, unknown>();
	return {
		get: <T>(key: string) => entries.get(key) as T | undefined,
		set: (key, value) => {
			if (value === undefined) entries.delete(key);
			else entries.set(key, value);
		},
		clear: () => entries.clear(),
		destroy: () => entries.clear(),
	};
}

const EMAIL = "mike@example.com";

beforeAll(initDb);

describe("passkeyConfig", () => {
	it("reads rpID and origin from config and throws when unset", () => {
		expect(
			passkeyConfig(passkeyOnly({ rpId: "example.com", origin: "https://example.com", rpName: "Example" })),
		).toEqual({ rpID: "example.com", origin: "https://example.com" });
		expect(() => passkeyConfig(passkeyOnly(null))).toThrow();
	});

	it("rejects an origin that is not exactly scheme://host[:port]", () => {
		expect(() =>
			passkeyConfig(passkeyOnly({ rpId: "example.com", origin: "https://example.com/app", rpName: "Example" })),
		).toThrow();
	});

	it("refuses a localhost rpID on an https origin", () => {
		expect(() =>
			passkeyConfig(passkeyOnly({ rpId: "localhost", origin: "https://app.example.com", rpName: "Example" })),
		).toThrow();
	});

	it("refuses an rpID that is not a suffix of the origin host", () => {
		expect(() =>
			passkeyConfig(passkeyOnly({ rpId: "app.example.org", origin: "https://app.example.com", rpName: "Example" })),
		).toThrow();
		expect(
			passkeyConfig(passkeyOnly({ rpId: "example.com", origin: "https://app.example.com", rpName: "Example" })),
		).toEqual({ rpID: "example.com", origin: "https://app.example.com" });
	});
});

describe("passkey endpoints", () => {
	it("passkey endpoints require auth where expected", async () => {
		const res = await SELF.fetch("http://example.com/passkeys/register/options", {
			method: "POST",
			redirect: "manual",
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/login");
	});

	it("registration options are bound to the signed-in user", async () => {
		const session = await signUpAndLogIn(EMAIL);
		const res = await postJson("/passkeys/register/options", {}, session);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			rp: { id: string; name: string };
			challenge: string;
			user: { id: string; name: string };
			authenticatorSelection: { residentKey: string; userVerification: string };
		};
		// Whatever rpID this deployment is configured with, never a hardcoded one.
		expect(body.rp.id).toBe(testConfig.passkeys?.rpId);
		expect(body.challenge).toBeTruthy();
		expect(body.authenticatorSelection.residentKey).toBe("required");
		expect(body.authenticatorSelection.userVerification).toBe("required");

		// The base64url user handle decodes to the signed-in user's email,
		// so two accounts never share a discoverable credential.
		const handle = Buffer.from(body.user.id, "base64url").toString("utf8");
		expect(handle).toBe(String(EMAIL));
	});

	it("rejects a registration verification with no outstanding challenge", async () => {
		const session = await signUpAndLogIn(EMAIL);
		const res = await postJson("/passkeys/register/verify", { credential: { id: "nope" } }, session);
		expect(res.status).toBe(400);
	});

	it("login options are public and challenge-bound", async () => {
		const res = await postJson("/login/passkey/options", {}, await startSession("/login"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { challenge: string; allowCredentials: unknown[]; rpId: string };
		expect(body.challenge).toBeTruthy();
		expect(body.allowCredentials).toEqual([]);
		expect(body.rpId).toBe(testConfig.passkeys?.rpId);
	});

	it("rejects a passkey login for an unregistered credential", async () => {
		const session = await startSession("/login");
		await postJson("/login/passkey/options", {}, session);
		const res = await postJson("/login/passkey/verify", { credential: { id: "unknown-credential" } }, session);
		expect(res.status).toBe(404);
		expect(await res.text()).toContain("not registered");
	});

	it("scopes stored credentials to their owner", async () => {
		// A second allowlisted account, so two users' credentials can coexist.
		await signUpAndLogIn("richel@example.com");
		const { results: rows } = await env.DB.prepare("SELECT id, email FROM users").all<{ id: number; email: string }>();
		const mike = rows.find((row) => row.email === "mike@example.com");
		const richel = rows.find((row) => row.email === "richel@example.com");
		if (!mike || !richel) throw new Error(`expected both allowlisted users after signup: ${JSON.stringify(rows)}`);

		const shared = {
			publicKey: "AAAA",
			credentialType: "public-key" as const,
			deviceType: "singleDevice" as const,
			backedUp: false,
			aaguid: "test-aaguid",
			name: "Passkey",
			transports: ["internal"],
			counter: 0,
			createdAt: new Date().toISOString(),
			lastUsedAt: null,
		};
		await savePasskeyCredential(env.DB, { ...shared, id: "cred-mike", userId: mike.id });
		await savePasskeyCredential(env.DB, { ...shared, id: "cred-richel", userId: richel.id });

		// A credential lookup is global (that is how sign-in finds the owner)…
		expect((await getPasskeyById(env.DB, "cred-richel"))?.userId).toBe(richel.id);
		// …while each user's settings list only ever shows their own.
		expect((await listPasskeysByUser(env.DB, mike.id)).map((cred) => cred.id)).toEqual(["cred-mike"]);
	});
});

describe("passkey challenges", () => {
	it("binds a challenge to the session and consumes it exactly once", () => {
		const session = fakeSession();
		const challenge = issuePasskeyChallenge(session, "registration");
		expect(challenge).toHaveLength(43);

		const first = consumePasskeyChallenge(session, "registration");
		expect(first).toEqual({ challenge, userVerification: "required" });
		// Single use: the ceremony cannot be replayed with the same challenge.
		expect(consumePasskeyChallenge(session, "registration")).toBeNull();
	});

	it("rejects an expired challenge and clears it anyway", () => {
		const session = fakeSession();
		issuePasskeyChallenge(session, "authentication", 1_000);

		expect(consumePasskeyChallenge(session, "authentication", 1_000 + 5 * 60 * 1000)).not.toBeNull();
		issuePasskeyChallenge(session, "authentication", 1_000);
		expect(consumePasskeyChallenge(session, "authentication", 1_000 + 5 * 60 * 1000 + 1)).toBeNull();
		expect(consumePasskeyChallenge(session, "authentication", 1_000)).toBeNull();
	});

	it("rejects a challenge whose stored userVerification is not 'required'", () => {
		const session = fakeSession();
		issuePasskeyChallenge(session, "registration");
		session.set("passkeyRegistrationUserVerification", "preferred");
		expect(consumePasskeyChallenge(session, "registration")).toBeNull();
	});
});

describe("passkey counter replay guard", () => {
	it("advances a counter and throws on a non-advancing (replayed) one", async () => {
		await signUpAndLogIn("richel@example.com");
		const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
			.bind("richel@example.com")
			.first<{ id: number }>();
		await savePasskeyCredential(env.DB, {
			id: "cred-counter",
			userId: user!.id,
			publicKey: "AAAA",
			credentialType: "public-key",
			deviceType: "singleDevice",
			backedUp: false,
			aaguid: "test-aaguid",
			name: "Passkey",
			transports: ["internal"],
			counter: 5,
			createdAt: new Date().toISOString(),
			lastUsedAt: null,
		});

		await updatePasskeyCounter(env.DB, "cred-counter", 6, new Date().toISOString());
		expect((await getPasskeyById(env.DB, "cred-counter"))?.counter).toBe(6);
		// A signature counter that moves backwards is a cloned authenticator.
		await expect(updatePasskeyCounter(env.DB, "cred-counter", 4, new Date().toISOString())).rejects.toThrow(
			"did not advance",
		);
		expect((await getPasskeyById(env.DB, "cred-counter"))?.counter).toBe(6);
		// Equal counters are allowed through this guard: a stored 0 means the
		// authenticator does not report a counter (common for synced passkeys),
		// and equality for a real counter is rejected by @simplewebauthn/server's
		// own verifyAuthenticationResponse check.
		await updatePasskeyCounter(env.DB, "cred-counter", 6, new Date().toISOString());
		expect((await getPasskeyById(env.DB, "cred-counter"))?.counter).toBe(6);
	});
});
