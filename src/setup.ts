import { normalizeEmail } from "./auth.js";
import type { SqlDatabase } from "./ports.js";

/**
 * First-run setup. A fresh database has no accounts and no allowlist, so the
 * app would otherwise present a login screen nobody can pass. Exactly one
 * account may be created this way; every later account goes through the normal
 * invitation flow.
 */

/** How many accounts exist. */
export async function userCount(db: SqlDatabase): Promise<number> {
	const row = await db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number | string }>();
	return Number(row?.n ?? 0);
}

/**
 * Claims the single setup slot, atomically.
 *
 * The marker lives in `settings`, so the claim is one conditional insert that
 * only one caller can win. Checking `COUNT(*)` first and then inserting would
 * let two simultaneous submissions both pass the check and create two
 * accounts; the database decides here, not the request.
 */
export async function claimSetup(db: SqlDatabase): Promise<boolean> {
	const result = await db
		.prepare("INSERT INTO settings (key, value) VALUES ('setup_claim', 'claimed') ON CONFLICT(key) DO NOTHING")
		.run();
	return result.meta.changes === 1;
}

/**
 * Releases a claim whose account creation failed, so a transient error does not
 * leave a deployment that can neither be set up nor signed into.
 */
export async function releaseSetup(db: SqlDatabase): Promise<void> {
	await db.prepare("DELETE FROM settings WHERE key = 'setup_claim'").run();
}

/** The email, normalised, plus the raw fields the form needs on a re-render. */
export interface SetupInput {
	email: string;
	name: string;
	password: string;
	token: string;
}

export function readSetupInput(body: Record<string, unknown>): SetupInput {
	return {
		email: normalizeEmail(String(body.email ?? "")),
		name: String(body.name ?? "").trim(),
		password: String(body.password ?? ""),
		token: String(body.token ?? ""),
	};
}