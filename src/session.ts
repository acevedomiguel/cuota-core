import { createMiddleware } from "hono/factory";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "./app-env.js";
import { getSetting, insertSettingIfAbsent, setSetting } from "./db.js";
import type { Session, SqlDatabase } from "./ports.js";

export const SESSION_COOKIE = "cuota_session";
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

export class CookieSession implements Session {
	public dirty = false;
	public destroyed = false;
	private data: Record<string, unknown>;

	constructor(data: Record<string, unknown>) {
		this.data = data;
	}

	get<T>(key: string): T | undefined {
		return this.data[key] as T | undefined;
	}

	set(key: string, value: unknown): void {
		this.dirty = true;
		if (value === undefined) delete this.data[key];
		else this.data[key] = value;
	}

	clear(): void {
		this.dirty = true;
		this.data = {};
	}

	destroy(): void {
		this.dirty = true;
		this.destroyed = true;
		this.data = {};
	}

	serialize(): Record<string, unknown> {
		return this.data;
	}
}

function b64url(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(text: string): Uint8Array {
	const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

async function hmacKey(keyBytes: Uint8Array): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		keyBytes as BufferSource,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

export async function signSessionPayload(data: Record<string, unknown>, keyBytes: Uint8Array): Promise<string> {
	const body = b64url(new TextEncoder().encode(JSON.stringify(data)));
	const key = await hmacKey(keyBytes);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
	return `${body}.${b64url(new Uint8Array(signature))}`;
}

export async function verifySessionPayload(
	token: string,
	keyBytes: Uint8Array,
): Promise<Record<string, unknown> | null> {
	const dot = token.lastIndexOf(".");
	if (dot <= 0) return null;
	const body = token.slice(0, dot);
	let signature: Uint8Array;
	try {
		signature = unb64url(token.slice(dot + 1));
	} catch {
		return null;
	}
	const key = await hmacKey(keyBytes);
	const valid = await crypto.subtle.verify("HMAC", key, signature as BufferSource, new TextEncoder().encode(body));
	if (!valid) return null;
	try {
		const parsed: unknown = JSON.parse(new TextDecoder().decode(unb64url(body)));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function encodeKey(key: Uint8Array): string {
	return btoa(String.fromCharCode(...key));
}

/**
 * The cookie-signing key, created once and kept in `settings` so sessions
 * survive a restart or a move between databases.
 *
 * Creation is a race, not a read-then-write: two requests arriving together on
 * a fresh database must agree on one key, or one of them would sign a cookie
 * the other rejects. The insert is therefore conditional, and the value read
 * back afterwards is authoritative — including when someone else won.
 */
export async function getOrCreateSessionKey(db: SqlDatabase): Promise<Uint8Array> {
	const existing = await readSessionKey(db);
	if (existing) return existing;

	const generated = new Uint8Array(32);
	crypto.getRandomValues(generated);
	await insertSettingIfAbsent(db, "session_key", encodeKey(generated));

	const stored = await readSessionKey(db);
	if (stored) return stored;

	// The row exists but is unusable: not base64, or not 32 bytes. Refusing to
	// start would lock every user out until someone edited the database, so
	// replace it. Sessions signed with the old key are invalidated, which is
	// the honest outcome — they could never be verified again anyway.
	await setSetting(db, "session_key", encodeKey(generated));

	const replaced = await readSessionKey(db);
	if (!replaced) throw new Error("could not persist the session key");
	return replaced;
}

async function readSessionKey(db: SqlDatabase): Promise<Uint8Array | null> {
	const existing = await getSetting(db, "session_key");
	if (!existing) return null;
	try {
		const key = unb64url(existing);
		return key.length === 32 ? key : null;
	} catch {
		return null;
	}
}

export const sessionMiddleware = createMiddleware<AppEnv>(async (c, next) => {
	const key = await getOrCreateSessionKey(c.get("db"));
	const raw = getCookie(c, SESSION_COOKIE);
	const data = raw ? await verifySessionPayload(raw, key) : null;
	const session = new CookieSession(data ?? {});
	c.set("session", session);

	await next();

	if (session.destroyed) {
		deleteCookie(c, SESSION_COOKIE, { path: "/" });
		return;
	}
	// Re-issue on any live session, not only mutated ones, so the 30-day
	// expiry rolls with activity instead of the first visit.
	if (session.dirty || Object.keys(session.serialize()).length > 0) {
		const token = await signSessionPayload(session.serialize(), key);
		setCookie(c, SESSION_COOKIE, token, {
			path: "/",
			httpOnly: true,
			sameSite: "Lax",
			secure: new URL(c.req.url).protocol === "https:",
			maxAge: SESSION_MAX_AGE,
		});
	}
});