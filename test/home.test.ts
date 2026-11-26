import { env } from "./harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import { getUserByEmail } from "../src/db.js";
import { currentBalance } from "../src/balance.js";
import { getPage, initDb, postForm, signUpAndLogIn, type FormSession } from "./helpers.js";

const db = () => env.DB;

beforeAll(initDb);

const idOf = async (email: string) => (await getUserByEmail(db(), email))!.id;

let session: FormSession;
let mike = 0;
let richel = 0;

async function seed(incomeMike: number, incomeRichel: number): Promise<void> {
	await db().prepare("DELETE FROM incomes").run();
	await db().prepare("DELETE FROM expenses").run();
	await db().prepare("DELETE FROM snapshots").run();
	await db().prepare("DELETE FROM balance_events").run();
	if (incomeMike > 0) {
		await db()
			.prepare("INSERT INTO incomes (user_id, amount_cents, created_at) VALUES (?, ?, ?)")
			.bind(mike, incomeMike, "2026-01-01T00:00:00.000Z")
			.run();
	}
	if (incomeRichel > 0) {
		await db()
			.prepare("INSERT INTO incomes (user_id, amount_cents, created_at) VALUES (?, ?, ?)")
			.bind(richel, incomeRichel, "2026-01-01T00:00:00.000Z")
			.run();
	}
}

async function addExpense(
	description: string,
	amountCents: number,
	payerId: number,
	date = "2026-11-20",
	createdAt = "2026-11-20T09:00:00.000Z",
): Promise<void> {
	// created_at is explicit on purpose: a salary is resolved from the timeline
	// by timestamp, and two rows written in the same millisecond are genuinely
	// the same instant. Pinning it keeps each split unambiguous.
	await db()
		.prepare("INSERT INTO expenses (date, description, amount_cents, payer_id, created_at) VALUES (?, ?, ?, ?, ?)")
		.bind(date, description, amountCents, payerId, createdAt)
		.run();
}

describe("home dashboard", () => {
	beforeAll(async () => {
		session = await signUpAndLogIn("mike@example.com");
		await signUpAndLogIn("richel@example.com");
		mike = await idOf("mike@example.com");
		richel = await idOf("richel@example.com");
	});

	it("shows who owes whom from live data, with the current ratio bar", async () => {
		await seed(58000, 42000);
		await addExpense("Rent", 100000, mike);
		await addExpense("Groceries", 50000, richel);

		const html = await getPage(session, "/");
		expect(html).toContain("owes");
		expect(html).toContain("HK$");
		expect(html).toContain("58%");
		// 1000.00 at 58% is Mike's share; he also fronted it, so Richel owes
		// her 42%: 42000 cents. The hero names Richel as the one who owes.
		expect(html).toContain("HK$ 420.00");
	});

	it("shows an even balance without 'settle' language", async () => {
		await seed(58000, 42000);
		const html = await getPage(session, "/");
		expect(await currentBalance(db(), mike, richel)).toBe(0);
		// balanceLabel is escaped on the way through EJS.
		expect(html).toContain("You&#39;re even");
		expect(html.toLowerCase()).not.toContain("settle");
	});

	it("escapes expense descriptions (XSS pin)", async () => {
		await seed(58000, 42000);
		await addExpense("<script>alert(1)</script>", 10000, mike);

		const html = await getPage(session, "/");
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&lt;script&gt;");
	});

	it("shows 100/0 sanely when one user has no income", async () => {
		await seed(58000, 0);
		await addExpense("Rent", 100000, mike);

		const html = await getPage(session, "/");
		expect(html).toContain("100%");
		expect(html).toContain("0%");
		expect(html).not.toContain("NaN");
	});

	it("prompts to set up salaries when either user has none, and to add an expense when empty", async () => {
		await seed(0, 0);
		const html = await getPage(session, "/");
		expect(html).toContain("No expenses yet");
		expect(html).toContain("/incomes");
	});

	it("lists the 10 most recent expenses with per-person share", async () => {
		await seed(58000, 42000);
		for (let i = 1; i <= 10; i += 1) {
			await addExpense(`Item ${i}`, 1000 + i, mike, `2026-11-${String(i).padStart(2, "0")}`);
		}
		// Newest entry, fronted by the other person, so the row shows the
		// viewer's own share rather than "their share".
		await addExpense("Item 11", 1011, richel, "2026-11-11");

		const html = await getPage(session, "/");
		expect(html).toContain("Item 11");
		expect(html).not.toContain("Item 1<");
		const visible = html.match(/Item \d+/g) ?? [];
		expect(visible.length).toBe(10);
		expect(html).toContain("your share");
	});

	it("ignores a salary change made through the page until the expense is added", async () => {
		await seed(6000, 4000);
		await addExpense("Before", 10000, mike);

		// A salary POST seals a snapshot; the dashboard read must agree with a
		// full recompute, and the already-recorded expense keeps its split.
		await postForm("/incomes", { userId: String(richel), amount: "5000" }, session);
		const html = await getPage(session, "/");
		// 10000 at 60/40: Mike owes 6000, fronted 10000 → Richel owes 4000.
		expect(html).toContain("HK$ 40.00");
		expect(await currentBalance(db(), mike, richel)).toBe(4000);
	});
});
