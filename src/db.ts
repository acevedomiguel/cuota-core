import type { SqlDatabase, SqlValue } from "./ports.js";

export interface UserRow {
	id: number;
	email: string;
	name: string;
	password_hash: string;
	created_at: string;
}

export async function getSetting(db: SqlDatabase, key: string): Promise<string | null> {
	const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
	return row?.value ?? null;
}

export async function setSetting(db: SqlDatabase, key: string, value: string): Promise<void> {
	await db.prepare(
		"INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	).bind(key, value).run();
}

/**
 * Writes the value only when the key is absent, and never overwrites one that
 * exists. Used for the session key, where the first writer must win.
 */
export async function insertSettingIfAbsent(db: SqlDatabase, key: string, value: string): Promise<void> {
	await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING").bind(key, value).run();
}

export async function deleteSetting(db: SqlDatabase, key: string): Promise<void> {
	await db.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
}

export interface NewUser {
	email: string;
	name: string;
	passwordHash: string;
}

/** A household is one couple: at most two accounts. */
export const MAX_USERS = 2;

/** Thrown when an account is attempted after the two-person limit is reached. */
export class UserLimitReachedError extends Error {
	constructor() {
		super(`Cuota is limited to ${MAX_USERS} accounts`);
		this.name = "UserLimitReachedError";
	}
}

const INSERT_USER = "INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?) RETURNING id";

// The guarded insert decides the limit in the same statement that inserts, so
// two simultaneous signups cannot both pass a check and create a third account
// — the same reason `claimSetup` lets the database arbitrate. No returned row
// means the household was already full.
const INSERT_USER_WITHIN_LIMIT = `INSERT INTO users (email, name, password_hash)
	SELECT ?, ?, ? FROM (SELECT 1 AS one) AS guard
	WHERE (SELECT COUNT(*) FROM users) < ?
	RETURNING id`;

async function insertUser(db: SqlDatabase, sql: string, values: SqlValue[]): Promise<number | null> {
	const row = await db
		.prepare(sql)
		.bind(...values)
		.first<{ id: number }>();
	return row?.id ?? null;
}

/**
 * Creates an account without a limit. Used where the caller has already decided
 * who may exist (the first-run setup) and by tests that seed several rows; the
 * two-person rule belongs to `createUserWithinLimit`.
 */
export async function createUser(db: SqlDatabase, user: NewUser): Promise<number> {
	const id = await insertUser(db, INSERT_USER, [user.email, user.name, user.passwordHash]);
	if (id === null) throw new Error("could not create the user");
	return id;
}

/**
 * Creates an account unless the household is already full. Throws
 * `UserLimitReachedError` when two accounts exist, so a third signup is refused
 * by the server rather than only by the signup page.
 */
export async function createUserWithinLimit(db: SqlDatabase, user: NewUser): Promise<number> {
	const id = await insertUser(db, INSERT_USER_WITHIN_LIMIT, [user.email, user.name, user.passwordHash, MAX_USERS]);
	if (id === null) throw new UserLimitReachedError();
	return id;
}

export async function getUserByEmail(db: SqlDatabase, email: string): Promise<UserRow | null> {
	return await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>();
}

export async function getUserById(db: SqlDatabase, id: number): Promise<UserRow | null> {
	return await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

/**
 * Replaces one user's password hash. Deliberately touches no session rows: a
 * password change must not sign the user (or their other devices) out.
 */
export async function updatePasswordHash(db: SqlDatabase, userId: number, hash: string): Promise<void> {
	await db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(hash, userId).run();
}

/** Every account, oldest first. The app is a two-person household. */
export async function listUsers(db: SqlDatabase): Promise<UserRow[]> {
	const { results } = await db.prepare("SELECT * FROM users ORDER BY id ASC").all<UserRow>();
	return results ?? [];
}

function randomSessionId(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createDbSession(db: SqlDatabase, userId: number): Promise<string> {
	const id = randomSessionId();
	await db.prepare("INSERT INTO sessions (id, user_id) VALUES (?, ?)").bind(id, userId).run();
	return id;
}

export async function getSessionUserId(db: SqlDatabase, sessionId: string): Promise<number | null> {
	const row = await db
		.prepare("SELECT user_id FROM sessions WHERE id = ?")
		.bind(sessionId)
		.first<{ user_id: number }>();
	return row?.user_id ?? null;
}

export async function destroyDbSession(db: SqlDatabase, sessionId: string): Promise<void> {
	await db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
}