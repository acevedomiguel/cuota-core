// Receipt images kept with an expense. The bytes live in a ReceiptStore (a
// bucket binding, a directory, or memory); this module owns only the row that
// points at them and the small rules around a photo.

import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES } from "./deepseek.js";
import type { ReceiptStore, SqlDatabase, SqlValue } from "./ports.js";

export interface ReceiptRow {
	expense_id: number;
	object_key: string;
	content_type: string;
	byte_size: number;
	created_at: string;
}

/** A receipt photo is validated with the same rules as a scanned one. */
export const RECEIPT_IMAGE_TYPES = ALLOWED_IMAGE_TYPES;
export const MAX_RECEIPT_BYTES = MAX_IMAGE_BYTES;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A sanity ceiling on a retention window (100 years), so a wild value cannot
 * produce an out-of-range date. */
export const MAX_RETENTION_DAYS = 36_500;

/**
 * The instant before which a receipt counts as expired, for a window of `days`.
 * Shared so the list filter, the sweep, and the serve route agree on the
 * boundary. A window that is not a sane positive number means "keep forever":
 * the cutoff goes as far back as it can, so a wild value expires nothing rather
 * than everything.
 */
export function receiptCutoff(days: number, now: Date = new Date()): string {
	const bounded = Number.isFinite(days) && days > 0 ? Math.min(days, MAX_RETENTION_DAYS) : MAX_RETENTION_DAYS;
	return new Date(now.getTime() - bounded * DAY_MS).toISOString();
}

/** True when a retention window is set and usable. */
export function retentionEnabled(days: number | undefined): days is number {
	return days !== undefined && Number.isFinite(days) && days > 0;
}

/** Why a chosen photo cannot be kept, or null when it is acceptable. */
export function receiptProblem(file: { type: string; size: number }): "type" | "size" | null {
	if (!(RECEIPT_IMAGE_TYPES as readonly string[]).includes(file.type)) return "type";
	if (file.size > MAX_RECEIPT_BYTES) return "size";
	return null;
}

/** The receipt kept with an expense, if any. */
export async function getReceipt(db: SqlDatabase, expenseId: number): Promise<ReceiptRow | null> {
	return await db
		.prepare("SELECT * FROM receipts WHERE expense_id = ?")
		.bind(expenseId)
		.first<ReceiptRow>();
}

/**
 * Stores one photo for an expense, replacing any earlier one. The bytes go to
 * the store before the row is written — a row pointing at missing bytes would
 * render a broken link — and the superseded object is only dropped afterwards.
 */
export async function saveReceipt(
	db: SqlDatabase,
	store: ReceiptStore,
	expenseId: number,
	photo: { bytes: Uint8Array; type: string },
): Promise<void> {
	const previous = await getReceipt(db, expenseId);
	const key = crypto.randomUUID();
	await store.put(key, photo.bytes, photo.type);

	const createdAt = await db.now();
	try {
		await db
			.prepare(
				`INSERT INTO receipts (expense_id, object_key, content_type, byte_size, created_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(expense_id) DO UPDATE SET
				   object_key = excluded.object_key,
				   content_type = excluded.content_type,
				   byte_size = excluded.byte_size,
				   created_at = excluded.created_at`,
			)
			.bind(expenseId, key, photo.type, photo.bytes.length, createdAt)
			.run();
	} catch (error) {
		// The row was not written, so the object just stored is unreachable:
		// drop it rather than leave it orphaned, then let the caller decide.
		await store.delete(key).catch(() => {});
		throw error;
	}

	if (previous && previous.object_key !== key) {
		await store.delete(previous.object_key).catch(() => {});
	}
}

/**
 * Which of these expenses have a receipt worth linking, for the home list. With
 * `notBefore`, a receipt older than that instant is left out even though its row
 * is still there, so a photo past its retention window stops being offered the
 * moment it ages out rather than when something deletes it.
 */
export async function expensesWithReceipts(
	db: SqlDatabase,
	expenseIds: number[],
	notBefore?: string,
): Promise<Set<number>> {
	if (expenseIds.length === 0) return new Set();
	const placeholders = expenseIds.map(() => "?").join(", ");
	const where =
		notBefore === undefined
			? `expense_id IN (${placeholders})`
			: `expense_id IN (${placeholders}) AND created_at >= ?`;
	const bindings: SqlValue[] = notBefore === undefined ? expenseIds : [...expenseIds, notBefore];
	const { results } = await db
		.prepare(`SELECT expense_id FROM receipts WHERE ${where}`)
		.bind(...bindings)
		.all<{ expense_id: number }>();
	return new Set((results ?? []).map((row) => Number(row.expense_id)));
}

/**
 * Deletes receipts created before `cutoff` (an ISO instant, compared as text
 * like every other timestamp) and returns how many rows went.
 *
 * One statement, and it touches rows only: expiring the bytes is the store's own
 * business — an R2 lifecycle rule on the same window, say. A host that keeps
 * files on disk must prune them itself. Nothing is selected first, so a receipt
 * re-uploaded at the last moment (its `created_at` moved to now) is never in
 * scope.
 */
export async function pruneReceipts(db: SqlDatabase, cutoff: string): Promise<number> {
	const { meta } = await db.prepare("DELETE FROM receipts WHERE created_at < ?").bind(cutoff).run();
	return meta.changes;
}
