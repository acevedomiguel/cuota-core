import { env } from "./harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import { createUser, getUserByEmail } from "../src/db.js";
import {
	addBalanceEvent,
	addIncome,
	createExpense,
	createSnapshot,
	incomeAsOf,
	latestSnapshot,
	listExpenses,
	listIncomes,
	netBalanceEvents,
} from "../src/ledger.js";
import { initDb } from "./helpers.js";

const db = () => env.DB;

beforeAll(initDb);

/**
 * Insert a user row directly, bypassing the allowlist. Idempotent: these tests
 * share one seeded DB, and several `it`s seed the same fixture people.
 */
async function seedUser(email: string): Promise<number> {
	const existing = await getUserByEmail(db(), email);
	if (existing) return existing.id;
	return await createUser(db(), { email, name: email.split("@")[0], passwordHash: "pbkdf2:1:AA:BB" });
}

describe("expenses", () => {
	it("creates and lists expenses newest-first with payer", async () => {
		const mike = await seedUser("mike@example.com");
		await createExpense(db(), { date: "2026-11-20", description: "Rent", amountCents: 1750000, payerId: mike });
		await createExpense(db(), { date: "2026-11-22", description: "HK TV Mall", amountCents: 50000, payerId: mike });
		const rows = await listExpenses(db());
		expect(rows.map((r) => r.description)).toEqual(["HK TV Mall", "Rent"]);
		expect(rows[0].amount_cents).toBe(50000);
	});
});

describe("incomes", () => {
	it("incomeAsOf returns the latest salary recorded at or before a moment", async () => {
		const mike = await seedUser("mike@example.com");
		// Explicit createdAt: two rapid inserts can share a millisecond, and the
		// whole freeze semantics depends on a strict ordering of the timeline.
		await addIncome(db(), { userId: mike, amountCents: 6000000, createdAt: "2026-01-01T00:00:00.000Z" });
		const first = (await listIncomes(db()))[0].created_at;
		await addIncome(db(), { userId: mike, amountCents: 6500000, createdAt: "2026-07-01T00:00:00.000Z" });
		const second = (await listIncomes(db()))[1].created_at;
		expect(await incomeAsOf(db(), mike, first)).toBe(6000000);
		expect(await incomeAsOf(db(), mike, second)).toBe(6500000);
		expect(await incomeAsOf(db(), mike, "2000-01-01T00:00:00.000Z")).toBe(0);
	});
});

describe("balance events", () => {
	it("allows exactly one opening balance event and nets event direction", async () => {
		const mike = await seedUser("mike@example.com");
		const richel = await seedUser("richel@example.com");
		// Opening: richel owed mike 339.93 (the spreadsheet's ending balance).
		await addBalanceEvent(db(), { date: "2026-11-01", kind: "opening", fromUserId: richel, toUserId: mike, amountCents: 33993 });
		await expect(
			addBalanceEvent(db(), { date: "2026-11-02", kind: "opening", fromUserId: mike, toUserId: richel, amountCents: 1 }),
		).rejects.toThrow();
		// richel → mike money favors mike being owed (positive for A=mike).
		expect(await netBalanceEvents(db(), mike, richel)).toBe(33993);
		expect(await netBalanceEvents(db(), richel, mike)).toBe(-33993);
		// A settlement back (mike pays richel) reduces it.
		await addBalanceEvent(db(), { date: "2026-11-05", kind: "settlement", fromUserId: mike, toUserId: richel, amountCents: 10000 });
		expect(await netBalanceEvents(db(), mike, richel)).toBe(23993);
	});
});

describe("snapshots", () => {
	it("stores and returns the latest snapshot by cutoff", async () => {
		await createSnapshot(db(), { cutoff: "2026-06-01T00:00:00.000Z", balanceCents: 5000 });
		await createSnapshot(db(), { cutoff: "2026-11-01T00:00:00.000Z", balanceCents: 12000 });
		expect((await latestSnapshot(db()))?.balance_cents).toBe(12000);
		// Same cutoff twice is a conflict, never a silent second row.
		await expect(createSnapshot(db(), { cutoff: "2026-11-01T00:00:00.000Z", balanceCents: 1 })).rejects.toThrow();
	});
});
