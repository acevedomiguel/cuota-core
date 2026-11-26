import { createDbSession, destroyDbSession, getSessionUserId, getUserByEmail, getUserById } from "./db.js";
import type { AppConfig } from "./config.js";
import type { Session, SqlDatabase } from "./ports.js";

// 100,000 iterations: the ceiling a Workers runtime has historically allowed
// for PBKDF2. Raising it here would break verification of existing hashes.
const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;
const MIN_PASSWORD_LENGTH = 12;

function binaryOf(bytes: Uint8Array): string {
	let out = "";
	for (const b of bytes) out += String.fromCharCode(b);
	return out;
}

function fromBase64(encoded: string): Uint8Array {
	const binary = atob(encoded);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomBytes(length: number): Uint8Array {
	const out = new Uint8Array(length);
	crypto.getRandomValues(out);
	return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

async function derivePbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
		key,
		KEY_LENGTH * 8,
	);
	return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(SALT_LENGTH);
	const key = await derivePbkdf2(password, salt, PBKDF2_ITERATIONS);
	return `pbkdf2:${PBKDF2_ITERATIONS}:${btoa(binaryOf(salt))}:${btoa(binaryOf(key))}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
	try {
		const parts = encoded.split(":");
		if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
		const iterations = Number(parts[1]);
		if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1_000_000) return false;
		const salt = fromBase64(parts[2]);
		const expected = fromBase64(parts[3]);
		if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) return false;
		const actual = await derivePbkdf2(password, salt, iterations);
		return timingSafeEqual(actual, expected);
	} catch {
		return false;
	}
}

export function passwordLongEnough(password: string): boolean {
	return password.length >= MIN_PASSWORD_LENGTH;
}

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/** Allowlist membership: trimmed, case-insensitive. */
export function isEmailAllowed(config: AppConfig, email: string): boolean {
	const wanted = normalizeEmail(email);
	return config.allowedEmails.some((entry) => normalizeEmail(entry) === wanted);
}

/**
 * Starts an authenticated session for `userId`: a fresh row in `sessions`
 * plus the userId/sessionId pair carried in the signed cookie. Each login
 * gets its own row, so one user's login or logout never touches another's.
 * A re-login through the same browser session destroys that session's old
 * row rather than orphaning it.
 */
export async function establishAuthenticatedSession(
	db: SqlDatabase,
	session: Session,
	userId: number,
): Promise<void> {
	const previous = session.get<string>("sessionId");
	session.clear();
	session.set("authenticated", true);
	session.set("userId", userId);
	session.set("sessionId", await createDbSession(db, userId));
	if (typeof previous === "string") await destroyDbSession(db, previous);
	rotateCsrfToken(session);
}

/** True when the cookie's session row still exists for the same user. */
export async function isAuthenticated(db: SqlDatabase, session: Session): Promise<boolean> {
	if (session.get("authenticated") !== true) return false;
	const userId = session.get<number>("userId");
	const sessionId = session.get<string>("sessionId");
	if (typeof userId !== "number" || typeof sessionId !== "string") return false;
	return (await getSessionUserId(db, sessionId)) === userId;
}

/** The signed-in user's row, or null. */
export async function currentUser(db: SqlDatabase, session: Session) {
	if (!(await isAuthenticated(db, session))) return null;
	const userId = session.get<number>("userId");
	if (typeof userId !== "number") return null;
	return await getUserById(db, userId);
}

/** Used by signup to distinguish a duplicate email from a real failure. */
export async function emailTaken(db: SqlDatabase, email: string): Promise<boolean> {
	return (await getUserByEmail(db, normalizeEmail(email))) !== null;
}

function toHexBytes(length: number): string {
	return toHex(randomBytes(length));
}

export function ensureCsrfToken(session: Session): string {
	const existing = session.get<string>("csrfToken");
	if (typeof existing === "string" && existing.length === 64) return existing;
	const token = toHexBytes(32);
	session.set("csrfToken", token);
	return token;
}

export function rotateCsrfToken(session: Session): void {
	session.set("csrfToken", toHexBytes(32));
}

export function validCsrfToken(session: Session, candidate: unknown): boolean {
	if (typeof candidate !== "string") return false;
	const expected = session.get<string>("csrfToken");
	if (typeof expected !== "string") return false;
	return timingSafeEqual(new TextEncoder().encode(candidate), new TextEncoder().encode(expected));
}