import { env } from "./harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import { balanceCents, type CalcExpense } from "../src/calc.js";
import { getUserByEmail, type UserRow } from "../src/db.js";
import { latestSnapshot, listExpenses, listIncomes, netBalanceEvents } from "../src/ledger.js";
import { parseIncomeForm } from "../src/routes/incomes.js";
import { getPage, initDb, postForm, refreshCsrf, signUpAndLogIn } from "./helpers.js";

const db = () => env.DB;

beforeAll(initDb);

const users = [
	{ id: 1, email: "mike@example.com", name: "Mike" },
	{ id: 2, email: "richel@example.com", name: "Richel" },
] as UserRow[];

const countIncomes = async () =>
	Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM incomes").first<{ n: number }>())?.n ?? 0);

const idOf = async (email: string) => (await getUserByEmail(db(), email))!.id;

describe("parseIncomeForm", () => {
	it("accepts an amount and a known user, in cents", () => {
		const result = parseIncomeForm({ amount: "65000.50", userId: "2" }, users);
		expect(result.ok && result.value).toEqual({ userId: 2, amountCents: 6500050 });
	});

	it("rejects zero, negatives, 3 decimals, and unknown or missing users", () => {
		expect(parseIncomeForm({ amount: "0", userId: "1" }, users).ok).toBe(false);
		expect(parseIncomeForm({ amount: "-1", userId: "1" }, users).ok).toBe(false);
		expect(parseIncomeForm({ amount: "1.001", userId: "1" }, users).ok).toBe(false);
		expect(parseIncomeForm({ amount: "abc", userId: "1" }, users).ok).toBe(false);
		expect(parseIncomeForm({ amount: "1", userId: "99" }, users).ok).toBe(false);
		expect(parseIncomeForm({ amount: "1", userId: "" }, users).ok).toBe(false);
	});
});

describe("salary page", () => {
	it("lists each user's salary entries newest first, and shows the freeze copy", async () => {
		// Deterministic ordering via explicit createdAt (via the API the
		// database stamps these itself, to the millisecond).
		const session = await signUpAndLogIn("mike@example.com");
		await signUpAndLogIn("richel@example.com");
		const mike = await idOf("mike@example.com");
		const richel = await idOf("richel@example.com");
		await db()
			.prepare("INSERT INTO incomes (user_id, amount_cents, created_at) VALUES (?, ?, ?)")
			.bind(mike, 600000, "2026-01-01T00:00:00.000Z")
			.run();
		await db()
			.prepare("INSERT INTO incomes (user_id, amount_cents, created_at) VALUES (?, ?, ?)")
			.bind(mike, 650000, "2026-02-01T00:00:00.000Z")
			.run();
		await db()
			.prepare("INSERT INTO incomes (user_id, amount_cents, created_at) VALUES (?, ?, ?)")
			.bind(richel, 400000, "2026-01-15T00:00:00.000Z")
			.run();

		const html = await getPage(session, "/incomes");
		// Within a user, the newer entry renders first.
		expect(html.indexOf("HK$ 6,500.00")).toBeLessThan(html.indexOf("HK$ 6,000.00"));
		expect(html).toContain("HK$ 4,000.00");
		expect(html).toContain("applies to expenses added from now on");
	});

	it("records a salary, seals a snapshot, and redirects back", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		const mike = await idOf("mike@example.com");
		const before = await countIncomes();
		const res = await postForm("/incomes", { userId: String(mike), amount: "58000" }, session);
		expect(res.status).toBe(303);
		expect(await countIncomes()).toBe(before + 1);
		expect((await latestSnapshot(db()))?.balance_cents).toBeTypeOf("number");
	});

	it("rejects an invalid salary with 422 and stores nothing", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		const mike = await idOf("mike@example.com");
		await refreshCsrf(session, "/incomes");
		const before = await countIncomes();
		const res = await postForm("/incomes", { userId: String(mike), amount: "1.001" }, session);
		expect(res.status).toBe(422);
		expect(await countIncomes()).toBe(before);
	});
});

describe("freeze-at-entry semantics end to end", () => {
	it("a new salary applies to later expenses only, and each entry seals a snapshot", async () => {
		const mike = await idOf("mike@example.com");
		const richel = await idOf("richel@example.com");
		const session = await signUpAndLogIn("mike@example.com");
		await refreshCsrf(session, "/incomes");

		// Reset the ledger this test cares about.
		await db().prepare("DELETE FROM incomes").run();
		await db().prepare("DELETE FROM expenses").run();
		await db().prepare("DELETE FROM snapshots").run();
		await db().prepare("DELETE FROM balance_events").run();

		// Mike alone earns: 100/0. A first expense is frozen with that ratio.
		await db()
			.prepare("INSERT INTO incomes (user_id, amount_cents, created_at) VALUES (?, ?, ?)")
			.bind(mike, 6000, "2026-01-01T00:00:00.000Z")
			.run();
		await db()
			.prepare("INSERT INTO expenses (date, description, amount_cents, payer_id, created_at) VALUES (?, ?, ?, ?, ?)")
			.bind("2026-01-02", "Before raise", 10000, mike, "2026-01-02T00:00:00.000Z")
			.run();

		// Mike records a lower salary, and Richel records hers: now 50/50.
		await db()
			.prepare("INSERT INTO incomes (user_id, amount_cents, created_at) VALUES (?, ?, ?)")
			.bind(mike, 5000, "2026-06-01T00:00:00.000Z")
			.run();
		await db()
			.prepare("INSERT INTO incomes (user_id, amount_cents, created_at) VALUES (?, ?, ?)")
			.bind(richel, 5000, "2026-06-01T00:00:00.000Z")
			.run();
		await db()
			.prepare("INSERT INTO expenses (date, description, amount_cents, payer_id, created_at) VALUES (?, ?, ?, ?, ?)")
			.bind("2026-06-02", "After split", 10000, mike, "2026-06-02T00:00:00.000Z")
			.run();

		// The two expenses carry different frozen ratios: 100/0 then 50/50.
		const rows = await listExpenses(db(), 5000);
		const incomes = await listIncomes(db());
		const salary = (userId: number, asOf: string) =>
			incomes.filter((i) => i.user_id === userId && i.created_at <= asOf).at(-1)?.amount_cents ?? 0;
		const calc: CalcExpense[] = rows.map((r) => ({
			amountCents: r.amount_cents,
			payerId: r.payer_id,
			createdAt: r.created_at,
		}));
		// The first expense is 100/0, so Mike owing it all nets to zero. The
		// second is 50/50: Mike fronted 10000 and owes 5000 → Richel owes 5000.
		const balance = balanceCents(
			calc,
			salary,
			mike,
			richel,
			await netBalanceEvents(db(), mike, richel),
		);
		expect(balance).toBe(5000);

		// Each salary POST seals exactly one snapshot, and the sealed number is
		// the full recompute at that moment.
		const snapshotCount = async () =>
			Number((await db().prepare("SELECT COUNT(*) AS n FROM snapshots").first<{ n: number }>())?.n ?? 0);
		const fullNow = async () =>
			balanceCents(
				(await listExpenses(db(), 5000)).map<CalcExpense>((r) => ({
					amountCents: r.amount_cents,
					payerId: r.payer_id,
					createdAt: r.created_at,
				})),
				salary,
				mike,
				richel,
				await netBalanceEvents(db(), mike, richel),
			);

		const first = await postForm("/incomes", { userId: String(richel), amount: "5000" }, session);
		expect(first.status).toBe(303);
		expect(await snapshotCount()).toBe(1);
		expect((await latestSnapshot(db()))?.balance_cents).toBe(await fullNow());

		await refreshCsrf(session, "/incomes");
		const second = await postForm("/incomes", { userId: String(mike), amount: "7000" }, session);
		expect(second.status).toBe(303);
		expect(await snapshotCount()).toBe(2);
		expect((await latestSnapshot(db()))?.balance_cents).toBe(await fullNow());
	});
});

describe("sharing rule", () => {
	it("stores a fixed percentage, shows it, and switches back to salaries", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		await signUpAndLogIn("richel@example.com");
		const mike = (await getUserByEmail(db(), "mike@example.com"))!.id;

		const before = await getPage(session, "/incomes");
		expect(before).toContain("How you split");
		expect(before).toContain("Salary ratio");

		await refreshCsrf(session, "/incomes");
		const saved = await postForm(
			"/incomes/sharing",
			{ mode: "fixed", subjectUserId: String(mike), percentage: "62.5" },
			session,
		);
		expect(saved.status).toBe(303);

		const after = await getPage(session, "/incomes");
		expect(after).toContain("62.5% to");
		// The switch-back control only exists while a fixed rule is in force.
		expect(after).toContain("Back to salary ratio");

		// A bad percentage is refused without recording a rule.
		await refreshCsrf(session, "/incomes");
		const rejected = await postForm(
			"/incomes/sharing",
			{ mode: "fixed", subjectUserId: String(mike), percentage: "150" },
			session,
		);
		expect(rejected.status).toBe(422);
		expect(await rejected.text()).toContain("between 0 and 100");

		await refreshCsrf(session, "/incomes");
		const back = await postForm("/incomes/sharing", { mode: "salary" }, session);
		expect(back.status).toBe(303);
		const salaries = await getPage(session, "/incomes");
		expect(salaries).not.toContain("Back to salary ratio");
	});
});
