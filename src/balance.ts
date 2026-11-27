// Snapshot-cached balance: the db-facing composition of Task 1's ledger
// helpers with the pure math in calc.ts.
//
// A snapshot is a *cache*, never a source of truth. It stores the balance as
// of a cutoff instant. A read returns snapshot.balance_cents + the fold of
// everything recorded at or after the cutoff. The boundary is strict and
// shared: rows with `created_at < cutoff` are sealed into the snapshot, rows
// with `created_at >= cutoff` are folded live — so no row is counted twice or
// skipped, and a snapshot can never go stale because expense splits are frozen
// at entry (a later salary change cannot alter the sealed rows' math).

import { balanceCents, type CalcExpense } from "./calc.js";
import type { SqlDatabase } from "./ports.js";
import {
	createSnapshot,
	latestSnapshot,
	listExpensesSince,
	listIncomes,
	netBalanceEvents,
	type ExpenseRow,
} from "./ledger.js";
import { listSharingRules, sharingResolver } from "./sharing.js";

function toCalc(rows: ExpenseRow[]): CalcExpense[] {
	return rows.map((r) => ({ amountCents: r.amount_cents, payerId: r.payer_id, createdAt: r.created_at }));
}

/** The database's clock, in the same millisecond ISO format as every row. */
async function dbNow(db: SqlDatabase): Promise<string> {
	return await db.now();
}

/**
 * The running balance (positive = `userA` is owed): the latest snapshot's
 * sealed number plus the live fold of rows recorded since its cutoff. With no
 * snapshot the fold covers the whole ledger, which is the identical result.
 */
export async function currentBalance(db: SqlDatabase, userA: number, userB: number): Promise<number> {
	const snapshot = await latestSnapshot(db);
	const cutoff = snapshot?.cutoff ?? "";
	const [expenses, incomes, rules] = await Promise.all([
		listExpensesSince(db, cutoff),
		listIncomes(db),
		listSharingRules(db),
	]);
	const events = await netBalanceEvents(db, userA, userB, cutoff || undefined);
	const live = balanceCents(toCalc(expenses), sharingResolver(incomes, rules, userA, userB), userA, userB, events);
	return (snapshot?.balance_cents ?? 0) + live;
}

/**
 * A cutoff strictly after every snapshot already stored. Two refreshes can
 * land in the same millisecond — a local process is fast enough — and the
 * cutoff is unique by design, so the clock alone is not enough. Bumping by a
 * millisecond preserves the append-only rule and the ordering reads rely on.
 */
async function nextCutoff(db: SqlDatabase): Promise<string> {
	const now = await dbNow(db);
	const latest = await latestSnapshot(db);
	if (!latest || latest.cutoff < now) return now;
	const previous = Date.parse(latest.cutoff);
	if (Number.isNaN(previous)) return now;
	return new Date(previous + 1).toISOString();
}

/**
 * Seals the era: recomputes the full balance over everything recorded strictly
 * before now and stores it as a snapshot with that cutoff. Called after every
 * salary change. Because the sealed range is `created_at < cutoff` and reads
 * fold `created_at >= cutoff`, a row in the cutoff millisecond is folded live
 * rather than sealed twice.
 */
export async function refreshSnapshot(db: SqlDatabase, userA: number, userB: number): Promise<void> {
	const cutoff = await nextCutoff(db);
	const [all, incomes, rules] = await Promise.all([
		listExpensesSince(db, ""),
		listIncomes(db),
		listSharingRules(db),
	]);
	const sealed = all.filter((e) => e.created_at < cutoff);
	const allEvents = await netBalanceEvents(db, userA, userB);
	const eventsSince = await netBalanceEvents(db, userA, userB, cutoff);
	const balance = balanceCents(toCalc(sealed), sharingResolver(incomes, rules, userA, userB), userA, userB, allEvents - eventsSince);
	await createSnapshot(db, { cutoff, balanceCents: balance });
}
