import { env } from "./harness.js";
import { beforeEach, describe, expect, it } from "vitest";
import { currentBalance } from "../src/balance.js";
import { createUser, getUserByEmail } from "../src/db.js";
import { addIncome, createExpense } from "../src/ledger.js";
import { addSharingRule, currentRatio, listSharingRules } from "../src/sharing.js";
import { formatPercentage, parsePercentageToBps } from "../src/routes/incomes.js";
import { initDb } from "./helpers.js";

/**
 * MIL-34: a couple may split by the salary ratio (the default) or by a fixed
 * percentage. Both are timelines: a change never rewrites an expense already
 * recorded. These tests drive the ledger directly, so they pin the arithmetic
 * without a browser.
 */

const db = () => env.DB;

let alice = 0;
let bob = 0;

async function ensureUser(email: string): Promise<number> {
	const existing = await getUserByEmail(db(), email);
	if (existing) return existing.id;
	return await createUser(db(), { email, name: email.split("@")[0], passwordHash: "pbkdf2:1:AA:BB" });
}

beforeEach(async () => {
	await initDb();
	alice = await ensureUser("share-a@example.com");
	bob = await ensureUser("share-b@example.com");
	for (const table of ["sharing_rules", "expenses", "incomes", "snapshots"]) {
		await db().prepare(`DELETE FROM ${table}`).run();
	}
});

describe("parsePercentageToBps", () => {
	it("accepts 0..100 with up to two decimals", () => {
		expect(parsePercentageToBps("50")).toBe(5000);
		expect(parsePercentageToBps("62.5")).toBe(6250);
		expect(parsePercentageToBps("62.55")).toBe(6255);
		expect(parsePercentageToBps("0")).toBe(0);
		expect(parsePercentageToBps("100")).toBe(10000);
		expect(parsePercentageToBps(" 62.5 ")).toBe(6250);
	});

	it("rejects anything else", () => {
		for (const bad of ["", "abc", "-1", "100.01", "50.123", "1e2", "1000", "10 0"]) {
			expect(parsePercentageToBps(bad), bad).toBeNull();
		}
	});
});

describe("formatPercentage", () => {
	it("renders basis points as the shortest decimal percentage", () => {
		expect(formatPercentage(5000)).toBe("50");
		expect(formatPercentage(6250)).toBe("62.5");
		expect(formatPercentage(6255)).toBe("62.55");
		expect(formatPercentage(0)).toBe("0");
		expect(formatPercentage(10000)).toBe("100");
	});
});

describe("sharing modes", () => {
	it("salary mode splits by the income ratio", async () => {
		await addIncome(db(), { userId: alice, amountCents: 6000 });
		await addIncome(db(), { userId: bob, amountCents: 4000 });
		await createExpense(db(), { date: "2026-11-20", description: "Rent", amountCents: 10000, payerId: alice });

		// Alice owes 60%; she fronted it all, so Bob owes her 4000.
		expect(await currentBalance(db(), alice, bob)).toBe(4000);
	});

	it("fixed mode splits by the percentage, with the other taking the rest", async () => {
		await addIncome(db(), { userId: alice, amountCents: 6000 });
		await addIncome(db(), { userId: bob, amountCents: 4000 });
		// A fixed rule overrides the salaries.
		await addSharingRule(db(), { mode: "fixed", subjectUserId: alice, percentageBps: 2500 });
		await createExpense(db(), { date: "2026-11-20", description: "Rent", amountCents: 10000, payerId: alice });

		// Alice owes 25% now, not 60%.
		expect(await currentBalance(db(), alice, bob)).toBe(7500);
		const rules = await listSharingRules(db());
		expect(currentRatio([], rules, alice, bob)).toEqual({ a: 0.25, b: 0.75 });
	});

	it("a rule change never rewrites an expense already recorded", async () => {
		await addIncome(db(), { userId: alice, amountCents: 5000 });
		await addIncome(db(), { userId: bob, amountCents: 5000 });
		// 50/50 at entry.
		await createExpense(db(), { date: "2026-11-20", description: "First", amountCents: 10000, payerId: alice });
		// Now Alice takes everything.
		await addSharingRule(db(), { mode: "fixed", subjectUserId: alice, percentageBps: 10000 });
		await createExpense(db(), { date: "2026-11-21", description: "Second", amountCents: 10000, payerId: alice });

		// The first expense still leaves Bob owing 5000; the second leaves nothing.
		expect(await currentBalance(db(), alice, bob)).toBe(5000);
	});

	it("a salary change never rewrites a past fixed-mode split", async () => {
		await addIncome(db(), { userId: alice, amountCents: 5000 });
		await addIncome(db(), { userId: bob, amountCents: 5000 });
		await addSharingRule(db(), { mode: "fixed", subjectUserId: bob, percentageBps: 5000 });
		await createExpense(db(), { date: "2026-11-20", description: "First", amountCents: 10000, payerId: alice });

		// Switching back to salaries does not touch the expense already frozen.
		await addSharingRule(db(), { mode: "salary" });
		await addIncome(db(), { userId: bob, amountCents: 9000 });
		await createExpense(db(), { date: "2026-11-21", description: "Second", amountCents: 10000, payerId: alice });

		// First: Bob owed 5000. Second at 5000/9000: Alice's floor share is 3571
		// and the leftover cent goes to the lower id (Alice), so she owes 3572.
		expect(await currentBalance(db(), alice, bob)).toBe(5000 + (10000 - 3572));
	});

	it("keeps the odd cent whole at a fractional percentage", async () => {
		await addIncome(db(), { userId: alice, amountCents: 5000 });
		await addIncome(db(), { userId: bob, amountCents: 5000 });
		// Alice is the lower id here, so she keeps the leftover cent.
		await addSharingRule(db(), { mode: "fixed", subjectUserId: alice, percentageBps: 6250 });
		await createExpense(db(), { date: "2026-11-20", description: "Odd", amountCents: 10001, payerId: alice });

		// 62.5% of 10001 is 6250.625 → 6250, leftover cent to Alice → 6251.
		expect(await currentBalance(db(), alice, bob)).toBe(10001 - 6251);
	});
});
