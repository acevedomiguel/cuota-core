import { describe, expect, it } from "vitest";
import { balanceCents, formatHKD, ratioAt, sharesForExpense, type CalcExpense } from "../src/calc.js";

describe("ratioAt", () => {
	it("splits by income ratio, 50/50 when neither has income, 100/0 when one-sided", () => {
		expect(ratioAt(6000000, 4000000)).toEqual({ a: 0.6, b: 0.4 });
		expect(ratioAt(0, 0)).toEqual({ a: 0.5, b: 0.5 });
		expect(ratioAt(5000000, 0)).toEqual({ a: 1, b: 0 });
	});
});

describe("sharesForExpense", () => {
	it("shares sum to the amount exactly, leftover cent to the lower-id user", () => {
		expect(sharesForExpense(10001, 0.5, true)).toEqual({ a: 5001, b: 5000 });
		expect(sharesForExpense(10001, 0.5, false)).toEqual({ a: 5000, b: 5001 });
		const { a, b } = sharesForExpense(999, 0.3333, true);
		expect(a + b).toBe(999);
	});

	it("never produces a negative share or an off-by-one total", () => {
		for (const amount of [1, 2, 3, 7, 99, 100, 333, 10001]) {
			for (const ratio of [0, 0.1, 0.25, 0.5, 0.6, 0.9, 1]) {
				for (const lower of [true, false]) {
					const { a, b } = sharesForExpense(amount, ratio, lower);
					expect(a + b).toBe(amount);
					expect(a).toBeGreaterThanOrEqual(0);
					expect(b).toBeGreaterThanOrEqual(0);
				}
			}
		}
	});
});

describe("balanceCents", () => {
	it("balance is paid minus share, integer-exact over many rows", () => {
		// 1000 expenses of 333 cents at 50/50: no drift, an exact integer out.
		// (The draft plan pinned 0 here, but the lower-id payer keeps the odd
		// cent at 50/50: they owe 167 of a 333 charge they fronted, +166/row.)
		const expenses: CalcExpense[] = Array.from({ length: 1000 }, () => ({
			amountCents: 333,
			payerId: 1,
			createdAt: "2026-11-01T00:00:00.000Z",
		}));
		const incomeAsOf = () => 100;
		expect(balanceCents(expenses, incomeAsOf, 1, 2)).toBe(166000);
	});

	it("freezes the split at entry: a later salary never re-splits an older expense", () => {
		const old = { amountCents: 10000, payerId: 1, createdAt: "2026-06-15T10:00:00.000Z" };
		const now = { amountCents: 10000, payerId: 1, createdAt: "2026-11-15T10:00:00.000Z" };
		// Salary timeline: 60/40 recorded in June, a "raise" (50/50) recorded in November.
		const incomes: Record<number, [string, number][]> = {
			1: [
				["2026-06-01T00:00:00.000Z", 6000],
				["2026-11-01T00:00:00.000Z", 5000],
			],
			2: [
				["2026-06-01T00:00:00.000Z", 4000],
				["2026-11-01T00:00:00.000Z", 5000],
			],
		};
		const incomeAsOf = (userId: number, asOf: string) =>
			(incomes[userId] ?? []).filter(([t]) => t <= asOf).at(-1)?.[1] ?? 0;
		// The June expense keeps 60/40 forever; the November one uses 50/50.
		expect(balanceCents([old], incomeAsOf, 1, 2)).toBe(10000 - 6000);
		expect(balanceCents([now], incomeAsOf, 1, 2)).toBe(10000 - 5000);
	});

	it("applies net balance events: opening debt and settlements move the balance", () => {
		const expenses = [{ amountCents: 10000, payerId: 1, createdAt: "2026-11-01T00:00:00.000Z" }];
		const incomeAsOf = () => 100; // 50/50
		// No events: payer fronted everything, is owed their counterpart's share.
		expect(balanceCents(expenses, incomeAsOf, 1, 2)).toBe(5000);
		// Opening: user 2 already owed user 1 33993 before tracking started.
		expect(balanceCents(expenses, incomeAsOf, 1, 2, 33993)).toBe(38993);
		// Settlement: user 1 paid user 2 10000 back (events now -10000 from 1's side).
		expect(balanceCents(expenses, incomeAsOf, 1, 2, 33993 - 10000)).toBe(28993);
	});
});

describe("formatHKD", () => {
	it("formats cents as HKD", () => {
		expect(formatHKD(124050)).toBe("HK$ 1,240.50");
		expect(formatHKD(-500)).toBe("-HK$ 5.00");
	});
});
