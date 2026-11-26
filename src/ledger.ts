// Data access for the expense ledger: expenses, the insert-only salary
// timeline, balance events, and balance snapshots. Every timestamp is written
// with the same millisecond ISO format (see migrations/0002_expenses.sql) so
// string comparison is also chronological comparison.

import { UNCATEGORIZED } from "./categories.js";
import type { SqlDatabase } from "./ports.js";

export interface ExpenseRow {
	id: number;
	date: string;
	description: string;
	amount_cents: number;
	payer_id: number;
	/** Category id; `uncategorized` for anything recorded before categories. */
	category: string;
	created_at: string;
}

export interface IncomeRow {
	id: number;
	user_id: number;
	amount_cents: number;
	created_at: string;
}

export interface BalanceEventRow {
	id: number;
	date: string;
	kind: "opening" | "settlement";
	from_user_id: number;
	to_user_id: number;
	amount_cents: number;
	note: string | null;
	created_at: string;
}

export interface SnapshotRow {
	id: number;
	cutoff: string;
	balance_cents: number;
	created_at: string;
}

export interface NewExpense {
	date: string;
	description: string;
	amountCents: number;
	payerId: number;
	/** Category id; omitted falls back to the `uncategorized` bucket. */
	category?: string;
	/** Test seam: forces `created_at`; defaults to the database clock. */
	createdAt?: string;
}

export async function createExpense(db: SqlDatabase, e: NewExpense): Promise<number> {
	const createdAt = e.createdAt ?? (await db.now());
	const row = await db
		.prepare(
			`INSERT INTO expenses (date, description, amount_cents, payer_id, category, created_at)
			 VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
		)
		.bind(e.date, e.description, e.amountCents, e.payerId, e.category ?? UNCATEGORIZED, createdAt)
		.first<{ id: number }>();
	if (!row) throw new Error("could not record the expense");
	return row.id;
}

/** Most recent expenses first (date DESC, id DESC). Bounded for display. */
export async function listExpenses(db: SqlDatabase, limit = 50): Promise<ExpenseRow[]> {
	const { results } = await db
		.prepare("SELECT * FROM expenses ORDER BY date DESC, id DESC LIMIT ?")
		.bind(limit)
		.all<ExpenseRow>();
	return results ?? [];
}

/**
 * Expenses recorded at or after `cutoff`, oldest first. An empty cutoff matches
 * every row, which is how the full (snapshot-free) fold reads the whole ledger.
 */
export async function listExpensesSince(db: SqlDatabase, cutoff: string): Promise<ExpenseRow[]> {
	const { results } = await db
		.prepare("SELECT * FROM expenses WHERE created_at >= ? ORDER BY created_at ASC, id ASC")
		.bind(cutoff)
		.all<ExpenseRow>();
	return results ?? [];
}

export interface NewIncome {
	userId: number;
	amountCents: number;
	/** Test seam: forces `created_at`; defaults to the database clock. */
	createdAt?: string;
}

export async function addIncome(db: SqlDatabase, i: NewIncome): Promise<number> {
	const createdAt = i.createdAt ?? (await db.now());
	const row = await db
		.prepare(
			`INSERT INTO incomes (user_id, amount_cents, created_at)
			 VALUES (?, ?, ?) RETURNING id`,
		)
		.bind(i.userId, i.amountCents, createdAt)
		.first<{ id: number }>();
	if (!row) throw new Error("could not record the income");
	return row.id;
}

/** The whole salary timeline, oldest first (created_at ASC, id ASC). */
export async function listIncomes(db: SqlDatabase): Promise<IncomeRow[]> {
	const { results } = await db
		.prepare("SELECT * FROM incomes ORDER BY created_at ASC, id ASC")
		.all<IncomeRow>();
	return results ?? [];
}

/**
 * A user's salary as of a moment: the latest entry recorded at or before
 * `asOf` (0 if none). Because the timeline is insert-only, this is exactly the
 * salary in force when an expense with that `created_at` was recorded.
 */
export async function incomeAsOf(db: SqlDatabase, userId: number, asOf: string): Promise<number> {
	const row = await db
		.prepare(
			"SELECT amount_cents FROM incomes WHERE user_id = ? AND created_at <= ? ORDER BY created_at DESC, id DESC LIMIT 1",
		)
		.bind(userId, asOf)
		.first<{ amount_cents: number }>();
	return row?.amount_cents ?? 0;
}

export interface NewBalanceEvent {
	date: string;
	kind: "opening" | "settlement";
	fromUserId: number;
	toUserId: number;
	amountCents: number;
	note?: string;
	/** Test seam: forces `created_at`; defaults to the database clock. */
	createdAt?: string;
}

/** Inserts an event. A second `opening` violates the partial unique index. */
export async function addBalanceEvent(db: SqlDatabase, e: NewBalanceEvent): Promise<number> {
	const createdAt = e.createdAt ?? (await db.now());
	const row = await db
		.prepare(
			`INSERT INTO balance_events (date, kind, from_user_id, to_user_id, amount_cents, note, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
		)
		.bind(e.date, e.kind, e.fromUserId, e.toUserId, e.amountCents, e.note ?? null, createdAt)
		.first<{ id: number }>();
	if (!row) throw new Error("could not record the balance event");
	return row.id;
}

/**
 * Net effect of balance events, in cents, oriented so a positive result means
 * A is owed: money that flowed from B to A counts +, A to B counts −. The
 * optional `since` filters to events recorded at or after a cutoff.
 */
export async function netBalanceEvents(
	db: SqlDatabase,
	userA: number,
	userB: number,
	since?: string,
): Promise<number> {
	const filter = since ? "AND created_at >= ?" : "";
	const sql = `
		SELECT
			COALESCE(SUM(
				CASE
					WHEN from_user_id = ? AND to_user_id = ? THEN amount_cents
					WHEN from_user_id = ? AND to_user_id = ? THEN -amount_cents
					ELSE 0
				END
			), 0) AS net
		FROM balance_events
		WHERE ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))
		${filter}`;
	const bindings: (number | string)[] = [userB, userA, userA, userB, userA, userB, userB, userA];
	if (since) bindings.push(since);
	const row = await db.prepare(sql).bind(...bindings).first<{ net: number }>();
	return Number(row?.net ?? 0);
}

/** The single opening-balance event, if one has been seeded. */
export async function openingEvent(db: SqlDatabase): Promise<BalanceEventRow | null> {
	return await db
		.prepare("SELECT * FROM balance_events WHERE kind = 'opening' LIMIT 1")
		.first<BalanceEventRow>();
}

/** The single opening-balance row, or null when tracking started from zero. */
export async function getOpeningBalance(db: SqlDatabase): Promise<BalanceEventRow | null> {
	return await db
		.prepare("SELECT * FROM balance_events WHERE kind = 'opening' LIMIT 1")
		.first<BalanceEventRow>();
}

/**
 * Removes the opening balance so it can be re-entered. There is deliberately no
 * edit flow — delete, then enter it again.
 */
export async function deleteOpeningBalance(db: SqlDatabase): Promise<void> {
	await db.prepare("DELETE FROM balance_events WHERE kind = 'opening'").run();
}

/** The most recent snapshot (the only one a read needs), or null. */
export async function latestSnapshot(db: SqlDatabase): Promise<SnapshotRow | null> {
	return await db
		.prepare("SELECT * FROM snapshots ORDER BY cutoff DESC LIMIT 1")
		.first<SnapshotRow>();
}

export interface NewSnapshot {
	cutoff: string;
	balanceCents: number;
}

/** Inserts a snapshot. Duplicate cutoffs violate the unique index. */
export async function createSnapshot(db: SqlDatabase, s: NewSnapshot): Promise<number> {
	const createdAt = await db.now();
	const row = await db
		.prepare(
			`INSERT INTO snapshots (cutoff, balance_cents, created_at)
			 VALUES (?, ?, ?) RETURNING id`,
		)
		.bind(s.cutoff, s.balanceCents, createdAt)
		.first<{ id: number }>();
	if (!row) throw new Error("could not record the snapshot");
	return row.id;
}