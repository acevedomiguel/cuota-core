// Receipt images kept with an expense. The bytes live in a ReceiptStore (a
// bucket binding, a directory, or memory); this module owns only the row that
// points at them and the small rules around a photo.

import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES } from "./deepseek.js";
import type { ReceiptStore, SqlDatabase } from "./ports.js";

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

/** Which of these expenses already have a receipt, for the home list. */
export async function expensesWithReceipts(db: SqlDatabase, expenseIds: number[]): Promise<Set<number>> {
	if (expenseIds.length === 0) return new Set();
	const placeholders = expenseIds.map(() => "?").join(", ");
	const { results } = await db
		.prepare(`SELECT expense_id FROM receipts WHERE expense_id IN (${placeholders})`)
		.bind(...expenseIds)
		.all<{ expense_id: number }>();
	return new Set((results ?? []).map((row) => Number(row.expense_id)));
}

/** Receipts created before `cutoff`, oldest first. */
export async function receiptsBefore(db: SqlDatabase, cutoff: string): Promise<ReceiptRow[]> {
	const { results } = await db
		.prepare("SELECT * FROM receipts WHERE created_at < ? ORDER BY created_at")
		.bind(cutoff)
		.all<ReceiptRow>();
	return results ?? [];
}

/**
 * Deletes every receipt created before `cutoff` (an ISO instant, compared as
 * text like every other timestamp): the stored object first, then the row.
 * Dropping the object is best-effort — if the store is down the row still goes,
 * so the home list stops advertising a photo nobody can open, and a host-side
 * lifecycle rule can sweep the leftover bytes. Removing a missing object or row
 * is a no-op, so a rerun is safe. Returns how many rows were removed.
 */
export async function pruneReceipts(db: SqlDatabase, store: ReceiptStore, cutoff: string): Promise<number> {
	const expired = await receiptsBefore(db, cutoff);
	for (const receipt of expired) {
		await store.delete(receipt.object_key).catch(() => {});
		await db.prepare("DELETE FROM receipts WHERE expense_id = ?").bind(receipt.expense_id).run();
	}
	return expired.length;
}
