import { env } from "./harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import { initDb } from "./helpers.js";
import { ensureCsrfToken, rotateCsrfToken, validCsrfToken } from "../src/auth.js";
import {
	CookieSession,
	getOrCreateSessionKey,
	signSessionPayload,
	verifySessionPayload,
} from "../src/session.js";
import type { Session } from "../src/ports.js";

describe("signed session payload", () => {
	it("round-trips a signed session payload and rejects tampering", async () => {
		const key = new Uint8Array(32);
		crypto.getRandomValues(key);
		const token = await signSessionPayload({ authenticated: true }, key);
		expect(await verifySessionPayload(token, key)).toEqual({ authenticated: true });
		const tampered = token.slice(0, -2) + "XX";
		expect(await verifySessionPayload(tampered, key)).toBeNull();
		const otherKey = new Uint8Array(32);
		crypto.getRandomValues(otherKey);
		expect(await verifySessionPayload(token, otherKey)).toBeNull();
	});

	it("rejects malformed tokens", async () => {
		const key = new Uint8Array(32).fill(7);
		expect(await verifySessionPayload("", key)).toBeNull();
		expect(await verifySessionPayload("no-dot", key)).toBeNull();
		expect(await verifySessionPayload("body.not-base64!!", key)).toBeNull();
	});
});

describe("session key", () => {
	beforeAll(async () => {
		await initDb();
		await env.DB.prepare("DELETE FROM settings WHERE key = 'session_key'").run();
	});

	it("creates and persists a 32-byte key, then reuses it", async () => {
		const first = await getOrCreateSessionKey(env.DB);
		expect(first.length).toBe(32);
		const second = await getOrCreateSessionKey(env.DB);
		expect(second).toEqual(first);
	});

	it("replaces a stored key that could never verify a session", async () => {
		// Truncated, not base64, or the wrong length: the old code regenerated
		// and overwrote, and refusing to start instead would lock everyone out
		// permanently. The row must be repaired, not just rejected.
		for (const broken of ["", "not-base64!!", btoa("too-short")]) {
			await env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'session_key'").bind(broken).run();
			const repaired = await getOrCreateSessionKey(env.DB);
			expect(repaired.length).toBe(32);
			// Stable from then on.
			expect(await getOrCreateSessionKey(env.DB)).toEqual(repaired);
		}
	});
});

describe("CookieSession", () => {
	it("tracks get/set/clear/destroy with the dirty flag", () => {
		const session = new CookieSession({ a: 1 });
		expect(session.get("a")).toBe(1);
		expect(session.dirty).toBe(false);
		session.set("b", 2);
		expect(session.dirty).toBe(true);
		expect(session.get("b")).toBe(2);
		session.set("a", undefined);
		expect(session.get("a")).toBeUndefined();
		session.clear();
		expect(session.get("b")).toBeUndefined();
		session.destroy();
		expect(session.destroyed).toBe(true);
	});
});

describe("csrf tokens", () => {
	it("validate and rotate", () => {
		// minimal fake implementing the Session interface
		const store: Record<string, unknown> = {};
		const session: Session = {
			get: <T>(k: string) => store[k] as T | undefined,
			set: (k, v) => {
				store[k] = v;
			},
			clear: () => {},
			destroy: () => {},
		};
		const token = ensureCsrfToken(session);
		expect(validCsrfToken(session, token)).toBe(true);
		expect(validCsrfToken(session, "wrong")).toBe(false);
		rotateCsrfToken(session);
		expect(validCsrfToken(session, token)).toBe(false);
	});

	it("reuses an existing token and rejects non-string candidates", () => {
		const session = new CookieSession({});
		const token = ensureCsrfToken(session);
		expect(ensureCsrfToken(session)).toBe(token);
		expect(validCsrfToken(session, undefined)).toBe(false);
		expect(validCsrfToken(session, 42)).toBe(false);
		expect(validCsrfToken(new CookieSession({}), token)).toBe(false);
	});
});
