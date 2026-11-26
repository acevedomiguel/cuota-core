import { env } from "./harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import { currentBalance, refreshSnapshot } from "../src/balance.js";
import { balanceCents, type CalcExpense } from "../src/calc.js";
import { createUser, getUserByEmail } from "../src/db.js";
import {
	addBalanceEvent,
	addIncome,
	createExpense,
	createSnapshot,
	latestSnapshot,
	listExpenses,
	listIncomes,
	netBalanceEvents,
	type ExpenseRow,
	type IncomeRow,
} from "../src/ledger.js";
import { initDb } from "./helpers.js";

const db = () => env.DB;

beforeAll(initDb);

async function seedUser(email: string): Promise<number> {
	const existing = await getUserByEmail(db(), email);
	if (existing) return existing.id;
	return await createUser(db(), { email, name: email.split("@")[0], passwordHash: "pbkdf2:1:AA:BB" });
}

const toCalc = (rows: ExpenseRow[]): CalcExpense[] =>
	rows.map((r) => ({ amountCents: r.amount_cents, payerId: r.payer_id, createdAt: r.created_at }));

/** A sync salary resolver over the whole timeline, for the pure fold. */
const resolver =
	(rows: IncomeRow[]) =>
	(userId: number, asOf: string): number => {
		let value = 0;
		for (const r of rows) if (r.user_id === userId && r.created_at <= asOf) value = r.amount_cents;
		return value;
	};

/** Full recompute from scratch, ignoring snapshots entirely. */
async function fullBalance(mike: number, richel: number): Promise<number> {
	const expenses = await listExpenses(db(), 5000);
	const incomes = await listIncomes(db());
	const events = await netBalanceEvents(db(), mike, richel);
	return balanceCents(toCalc(expenses), resolver(incomes), mike, richel, events);
}

describe("snapshot-cached balance", () => {
	it("snapshot + live delta equals a full recompute, with no boundary double-count", async () => {
		const mike = await seedUser("mike@example.com");
		const richel = await seedUser("richel@example.com");
		// Explicit createdAt avoids a same-millisecond tie in the freeze timeline.
		await addIncome(db(), { userId: mike, amountCents: 600000, createdAt: "2026-01-01T00:00:00.000Z" });
		await addIncome(db(), { userId: richel, amountCents: 400000, createdAt: "2026-01-01T00:00:00.000Z" });
		await addBalanceEvent(db(), { date: "2026-11-01", kind: "opening", fromUserId: richel, toUserId: mike, amountCents: 33993, createdAt: "2026-01-02T00:00:00.000Z" });
		await createExpense(db(), { date: "2026-11-10", description: "Rent", amountCents: 1750000, payerId: mike });
		await createExpense(db(), { date: "2026-11-11", description: "Groceries", amountCents: 50000, payerId: richel });
		await createExpense(db(), { date: "2026-11-12", description: "Taxi", amountCents: 1250, payerId: mike });

		await refreshSnapshot(db(), mike, richel);
		const snap = await latestSnapshot(db());
		expect(snap).not.toBeNull();

		// Rows recorded after the snapshot fold live on top of it.
		await createExpense(db(), { date: "2026-11-20", description: "Dinner", amountCents: 80000, payerId: mike });
		await createExpense(db(), { date: "2026-11-21", description: "Coffee", amountCents: 4500, payerId: richel });
		await addBalanceEvent(db(), { date: "2026-11-22", kind: "settlement", fromUserId: mike, toUserId: richel, amountCents: 10000 });

		expect(await currentBalance(db(), mike, richel)).toBe(await fullBalance(mike, richel));

		// Boundary: a row at created_at exactly == snapshot.cutoff is live, not
		// sealed — hence counted exactly once, and the cache still agrees.
		await db()
			.prepare(
				"INSERT INTO expenses (date, description, amount_cents, payer_id, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.bind("2026-11-23", "Boundary", 10000, mike, snap!.cutoff)
			.run();
		expect(await currentBalance(db(), mike, richel)).toBe(await fullBalance(mike, richel));
	});

	it("every salary change seals a snapshot equal to the recompute at that moment", async () => {
		const mike = await seedUser("mike@example.com");
		const richel = await seedUser("richel@example.com");

		const at = (t: string) => ({ createdAt: t });
		await addIncome(db(), { userId: mike, amountCents: 6000, ...at("2026-01-01T00:00:00.000Z") });
		await addIncome(db(), { userId: richel, amountCents: 4000, ...at("2026-01-01T00:00:00.000Z") });
		await createExpense(db(), { date: "2026-02-01", description: "A", amountCents: 10000, payerId: mike });

		await refreshSnapshot(db(), mike, richel);
		expect(await currentBalance(db(), mike, richel)).toBe(await fullBalance(mike, richel));

		await addIncome(db(), { userId: mike, amountCents: 5000, ...at("2026-06-01T00:00:00.000Z") });
		await addIncome(db(), { userId: richel, amountCents: 5000, ...at("2026-06-01T00:00:00.000Z") });
		await createExpense(db(), { date: "2026-07-01", description: "B", amountCents: 20000, payerId: richel });

		await refreshSnapshot(db(), mike, richel);
		const snap = await latestSnapshot(db());
		expect(await currentBalance(db(), mike, richel)).toBe(await fullBalance(mike, richel));

		// The sealed number is an independent recompute over rows strictly
		// before the cutoff (all-events minus events-since).
		const before = toCalc((await listExpenses(db(), 5000)).filter((r) => r.created_at < snap!.cutoff));
		const eventsBefore =
			(await netBalanceEvents(db(), mike, richel)) - (await netBalanceEvents(db(), mike, richel, snap!.cutoff));
		const expected = balanceCents(before, resolver(await listIncomes(db())), mike, richel, eventsBefore);
		expect(snap!.balance_cents).toBe(expected);

		await addIncome(db(), { userId: mike, amountCents: 7000, ...at("2026-09-01T00:00:00.000Z") });
		await addIncome(db(), { userId: richel, amountCents: 3000, ...at("2026-09-01T00:00:00.000Z") });
		await refreshSnapshot(db(), mike, richel);
		expect(await currentBalance(db(), mike, richel)).toBe(await fullBalance(mike, richel));
	});
});

describe("snapshots as a cache", () => {
	it("keeps one row per cutoff when two writers race", async () => {
		// `nextCutoff` orders sequential refreshes, but two processes can still
		// compute the same instant. The write is the tie-breaker: the later
		// recompute wins and the unique cutoff stays unique.
		await createSnapshot(db(), { cutoff: "2026-12-01T00:00:00.000Z", balanceCents: 100 });
		await createSnapshot(db(), { cutoff: "2026-12-01T00:00:00.000Z", balanceCents: 250 });

		const rows = await db()
			.prepare("SELECT balance_cents FROM snapshots WHERE cutoff = ?")
			.bind("2026-12-01T00:00:00.000Z")
			.all<{ balance_cents: number }>();

		expect(rows.results).toEqual([{ balance_cents: 250 }]);
	});
});
