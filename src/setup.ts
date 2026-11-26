import { normalizeEmail } from "./auth.js";
import type { SqlDatabase } from "./ports.js";

/**
 * First-run setup. A fresh database has no accounts and no allowlist, so the
 * app would otherwise present a login screen nobody can pass. Exactly one
 * account may be created this way; every later account goes through the normal
 * invitation flow.
 */

/**
 * How long an unfinished claim blocks another attempt. A claim is written
 * before the account, so a crash in between (an evicted Worker, a dropped
 * connection) would otherwise leave a deployment that can neither be set up nor
 * signed into. Engines with transactions roll the claim back; this covers the
 * ones without, which includes the serverless binding this app deploys on.
 */
export const SETUP_CLAIM_TTL_MS = 5 * 60 * 1000;

/** How many accounts exist. */
export async function userCount(db: SqlDatabase): Promise<number> {
	const row = await db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number | string }>();
	return Number(row?.n ?? 0);
}

const CLAIM_KEY = "setup_claim";

/**
 * Claims the single setup slot, atomically.
 *
 * The marker lives in `settings`, so the claim is one conditional insert that
 * only one caller can win. Checking `COUNT(*)` first and then inserting would
 * let two simultaneous submissions both pass the check and create two
 * accounts; the database decides here, not the request.
 *
 * The value is the claim's instant, which is what lets a stale claim be taken
 * over later.
 */
export async function claimSetup(db: SqlDatabase, claimedAt: string): Promise<boolean> {
	const result = await db
		.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING")
		.bind(CLAIM_KEY, claimedAt)
		.run();
	return result.meta.changes === 1;
}

/** The raw claim value, or null when nobody holds it. */
export async function readClaim(db: SqlDatabase): Promise<string | null> {
	const row = await db
		.prepare("SELECT value FROM settings WHERE key = ?")
		.bind(CLAIM_KEY)
		.first<{ value: string }>();
	return row?.value ?? null;
}

/** True when a claim exists and is older than the TTL (or unreadable). */
export function isClaimStale(claim: string | null, now: string): boolean {
	if (claim === null) return false;
	const claimedAt = Date.parse(claim);
	const current = Date.parse(now);
	if (Number.isNaN(claimedAt) || Number.isNaN(current)) return true;
	return current - claimedAt > SETUP_CLAIM_TTL_MS;
}

export type ClaimOutcome = "claimed" | "taken-over" | "in-progress";

/**
 * Claims the slot, taking over a claim left behind by a dead attempt. Returns
 * `in-progress` only when someone else claimed it recently and is presumably
 * still working.
 */
export async function claimSetupSlot(db: SqlDatabase, now: string): Promise<ClaimOutcome> {
	if (await claimSetup(db, now)) return "claimed";

	const existing = await readClaim(db);
	if (!isClaimStale(existing, now)) return "in-progress";

	// Compare-and-delete: only remove the row this attempt judged stale, so a
	// fresh claim written in the meantime is left alone.
	await db.prepare("DELETE FROM settings WHERE key = ? AND value = ?").bind(CLAIM_KEY, existing).run();
	return (await claimSetup(db, now)) ? "taken-over" : "in-progress";
}

/**
 * Releases a claim whose account creation failed, so a transient error does not
 * leave a deployment that can neither be set up nor signed into.
 */
export async function releaseSetup(db: SqlDatabase): Promise<void> {
	await db.prepare("DELETE FROM settings WHERE key = ?").bind(CLAIM_KEY).run();
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