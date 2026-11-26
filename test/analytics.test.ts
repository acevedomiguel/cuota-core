import { env, SELF } from "./harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import { type AnalyticExpense, parseYearParam, summarize, yearsWithData } from "../src/analytics.js";
import { categoryLabel, isValidCategory } from "../src/categories.js";
import { getUserByEmail } from "../src/db.js";
import { buildHome } from "../src/home.js";
import { listExpenses } from "../src/ledger.js";
import { handleAnalytics } from "../src/routes/analytics.js";
import { getPage, initDb, signUpAndLogIn, type FormSession } from "./helpers.js";

const db = () => env.DB;

beforeAll(initDb);

const exp = (date: string, amountCents: number, category = "other"): AnalyticExpense => ({
	date,
	amountCents,
	category,
});

/** The household's current date, as the app derives it (Hong Kong, UTC+8). */
const todayInHongKong = () => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

describe("parseYearParam", () => {
	it("accepts a four-digit year in range and rejects anything else", () => {
		expect(parseYearParam("2026")).toBe(2026);
		expect(parseYearParam("1999")).toBe(1999);
		expect(parseYearParam("abc")).toBeNull();
		expect(parseYearParam("26")).toBeNull();
		expect(parseYearParam("12345")).toBeNull();
		expect(parseYearParam("0000")).toBeNull();
		expect(parseYearParam("1969")).toBeNull();
		expect(parseYearParam("2026.5")).toBeNull();
		expect(parseYearParam("")).toBeNull();
		expect(parseYearParam(undefined)).toBeNull();
	});
});

describe("summarize", () => {
	it("zero-fills all twelve months and scales bars to the busiest month", () => {
		const a = summarize([exp("2026-01-10", 1000), exp("2026-03-05", 4000)], 2026, 2026);
		expect(a.months).toHaveLength(12);
		expect(a.months[0]).toMatchObject({ month: 1, totalCents: 1000, isZero: false, heightPct: 25 });
		expect(a.months[1]).toMatchObject({ month: 2, totalCents: 0, isZero: true, heightPct: 0 });
		expect(a.months[2]).toMatchObject({ month: 3, totalCents: 4000, heightPct: 100 });
		expect(a.months[11].isZero).toBe(true);
	});

	it("reconciles months, categories and the header total", () => {
		const expenses = [
			exp("2026-01-10", 1000, "groceries"),
			exp("2026-01-20", 2000, "groceries"),
			exp("2026-02-01", 3000, "dining"),
		];
		const a = summarize(expenses, 2026, 2026);
		expect(a.totalCents).toBe(6000);
		expect(a.months.reduce((s, m) => s + m.totalCents, 0)).toBe(6000);
		expect(a.categories.reduce((s, c) => s + c.totalCents, 0)).toBe(6000);
		expect(a.transactionCount).toBe(3);
		expect(a.hasData).toBe(true);
	});

	it("ranks the non-empty months, busiest first, ties chronologically", () => {
		const a = summarize([exp("2026-02-01", 500), exp("2026-04-01", 900), exp("2026-06-01", 500)], 2026, 2026);
		expect(a.topMonths.map((m) => m.month)).toEqual([4, 2, 6]);
		expect(a.topMonths.map((m) => m.rank)).toEqual([1, 2, 3]);
		expect(a.topMonths.every((m) => m.totalCents > 0)).toBe(true);
	});

	it("groups by category, largest first, with a largest-remainder share that sums to 100", () => {
		const expenses = [
			exp("2026-01-01", 1000, "groceries"),
			exp("2026-01-02", 1000, "dining"),
			exp("2026-01-03", 1000, "transport"),
		];
		const a = summarize(expenses, 2026, 2026);
		// Equal totals fall back to label order: Dining out, Groceries, Transport.
		expect(a.categories.map((c) => c.id)).toEqual(["dining", "groceries", "transport"]);
		expect(a.categories.reduce((s, c) => s + c.pct, 0)).toBe(100);
		expect(a.categories.map((c) => c.pct)).toEqual([34, 33, 33]);
	});

	it("buckets a missing category and title-cases an unknown one", () => {
		const a = summarize([exp("2026-01-01", 100, ""), exp("2026-01-02", 100, "yachts")], 2026, 2026);
		expect(a.categories.map((c) => c.label).sort()).toEqual(["Uncategorized", "Yachts"]);
	});

	it("reports an empty year as no data", () => {
		const a = summarize([exp("2025-05-01", 100)], 2026, 2026);
		expect(a.hasData).toBe(false);
		expect(a.totalCents).toBe(0);
		expect(a.transactionCount).toBe(0);
		expect(a.topMonths).toEqual([]);
		expect(a.categories).toEqual([]);
		expect(a.months.every((m) => m.isZero && m.heightPct === 0)).toBe(true);
	});

	it("offers data years plus the current and selected years, newest first", () => {
		const a = summarize([exp("2024-01-01", 1), exp("2025-01-01", 1), exp("2025-06-01", 1)], 2023, 2026);
		expect(a.years).toEqual([2026, 2025, 2024, 2023]);
	});
});

describe("yearsWithData", () => {
	it("lists distinct years newest first and ignores malformed dates", () => {
		expect(
			yearsWithData([exp("2025-01-01", 1), exp("2024-01-01", 1), exp("2025-09-01", 1), exp("nonsense", 1)]),
		).toEqual([2025, 2024]);
	});
});

describe("category helpers", () => {
	it("validates the known set plus the default bucket", () => {
		expect(isValidCategory("groceries")).toBe(true);
		expect(isValidCategory("uncategorized")).toBe(true);
		expect(isValidCategory("yachts")).toBe(false);
		expect(isValidCategory("")).toBe(false);
	});

	it("labels the default, known and unknown values", () => {
		expect(categoryLabel("uncategorized")).toBe("Uncategorized");
		expect(categoryLabel("")).toBe("Uncategorized");
		expect(categoryLabel("groceries")).toBe("Groceries");
		expect(categoryLabel("yachts")).toBe("Yachts");
	});
});

describe("analytics page", () => {
	let session: FormSession;
	let mike = 0;

	beforeAll(async () => {
		session = await signUpAndLogIn("mike@example.com");
		// A realistic two-person household; the analytics page only needs one.
		await signUpAndLogIn("richel@example.com");
		mike = (await getUserByEmail(db(), "mike@example.com"))!.id;
	});

	async function seed(rows: { date: string; description?: string; amountCents: number; category?: string }[]): Promise<void> {
		await db().prepare("DELETE FROM expenses").run();
		for (const row of rows) {
			await db()
				.prepare("INSERT INTO expenses (date, description, amount_cents, payer_id, category) VALUES (?, ?, ?, ?, ?)")
				.bind(row.date, row.description ?? "Expense", row.amountCents, mike, row.category ?? "uncategorized")
				.run();
		}
	}

	it("requires a signed-in user", async () => {
		const res = await SELF.fetch("http://example.com/analytics", { redirect: "manual" });
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/login");
	});

	it("renders the current year's totals, trend and category breakdown", async () => {
		const year = todayInHongKong().slice(0, 4);
		await seed([
			{ date: `${year}-01-10`, description: "Rent", amountCents: 100000, category: "housing" },
			{ date: `${year}-03-02`, description: "Groceries", amountCents: 50000, category: "groceries" },
		]);
		const html = await getPage(session, "/analytics");
		expect(html).toContain("Monthly spending");
		expect(html).toContain("Most expensive months");
		expect(html).toContain("By category");
		expect(html).toContain(`Total spent in ${year}`);
		expect(html).toMatch(new RegExp(`<option value="${year}" selected>`));
		expect(html).toContain("HK$ 1,500.00");
		expect(html).toContain("Housing");
		expect(html).toContain("Groceries");
	});

	it("lists data years in the selector", async () => {
		await seed([
			{ date: "2023-04-01", amountCents: 1000 },
			{ date: "2025-02-01", amountCents: 1000 },
		]);
		const html = await getPage(session, "/analytics");
		expect(html).toMatch(/<option value="2023"/);
		expect(html).toMatch(/<option value="2025"/);
	});

	it("filters to the selected year", async () => {
		await seed([
			{ date: "2023-04-01", description: "Old TV", amountCents: 100000, category: "shopping" },
			{ date: "2025-02-01", description: "New sofa", amountCents: 200000, category: "shopping" },
		]);
		const html = await getPage(session, "/analytics?year=2023");
		expect(html).toContain("HK$ 1,000.00");
		expect(html).not.toContain("HK$ 2,000.00");
	});

	it("renders an empty state for a year with no expenses", async () => {
		await seed([{ date: "2025-02-01", amountCents: 1000 }]);
		const html = await getPage(session, "/analytics?year=2024");
		expect(html).toContain("No expenses recorded in 2024");
		expect(html).not.toContain("Monthly spending");
	});

	it("falls back to the current year for a junk period", async () => {
		await seed([]);
		const year = todayInHongKong().slice(0, 4);
		const html = await getPage(session, "/analytics?year=abc");
		expect(html).toContain(`Total spent in ${year}`);
	});

	it("labels months with no spending rather than hiding them", async () => {
		await seed([{ date: "2025-07-04", description: "Lunch", amountCents: 5000, category: "dining" }]);
		const html = await getPage(session, "/analytics?year=2025");
		expect(html).toContain("January: no spending");
		expect(html).toContain("July: HK$ 50.00");
	});

	it("escapes an unexpected stored category", async () => {
		await seed([{ date: "2025-01-01", amountCents: 100, category: "<img src=x onerror=alert(1)>" }]);
		const html = await getPage(session, "/analytics?year=2025");
		expect(html).not.toContain("<img src=x onerror=alert(1)>");
		expect(html).toContain("&lt;img");
	});

	it("is reachable from the navigation, marked current on its own page", async () => {
		await seed([]);
		const html = await getPage(session, "/analytics");
		const sidebar = html.split('class="sidebar"')[1]?.split("</nav>")[0] ?? "";
		expect(sidebar).toMatch(/href="\/analytics" aria-current="page"/);
		const pill = html.split('class="bottombar"')[1]?.split("</nav>")[0] ?? "";
		expect(pill).toMatch(/href="\/analytics" class="active" aria-current="page"/);
	});

	it("shows a busy indicator on a year change without disabling the select", async () => {
		await seed([]);
		const html = await getPage(session, "/analytics");
		expect(html).toMatch(/data-analytics-loading[^>]*role="status"/);

		const script =
			(html.match(/<script>([\s\S]*?)<\/script>/g) ?? [])
				.map((block) => block.slice("<script>".length, -"</script>".length))
				.find((block) => block.includes("yearSelect")) ?? "";
		expect(script).toContain("yearLoading.hidden = false");
		expect(script).toContain("requestSubmit");
		// A disabled control is excluded from submission, so the form would
		// navigate without the chosen year — the regression this pins.
		expect(script).not.toMatch(/\.disabled\s*=\s*true/);
	});

	it("ships the analytics stylesheet hooks", async () => {
		const css = await (await SELF.fetch("http://example.com/static/styles.css")).text();
		expect(css).toContain(".chart-months");
		expect(css).toContain(".analytics-grid");
		expect(css).toContain(".cat-bar");
	});

	it("agrees with the home page's current-month spend", async () => {
		const today = todayInHongKong();
		const year = today.slice(0, 4);
		const month = today.slice(5, 7);
		// A month guaranteed to be outside the current one, so only the two
		// "today" rows feed the current-month figure.
		const otherMonth = month === "12" ? "01" : String(Number(month) + 1).padStart(2, "0");

		await seed([
			{ date: today, description: "This month A", amountCents: 12345, category: "groceries" },
			{ date: today, description: "This month B", amountCents: 6789, category: "dining" },
			{ date: `${year}-${otherMonth}-15`, description: "Other month", amountCents: 99999, category: "housing" },
		]);

		const home = await buildHome(db(), mike);
		const all = (await listExpenses(db(), 5000)).map<AnalyticExpense>((r) => ({
			date: r.date,
			amountCents: r.amount_cents,
			category: r.category,
		}));
		const analytics = summarize(all, Number(year), Number(year));

		// 12345 + 6789 = 19134 cents.
		expect(analytics.months[Number(month) - 1].totalCents).toBe(19134);
		expect(home.stats.spent).toBe("HK$ 191.34");
	});
});

describe("handleAnalytics", () => {
	it("renders the app's error page with a 500 when the ledger read fails", async () => {
		const broken = {
			prepare() {
				throw new Error("ledger unavailable");
			},
		} as unknown as Parameters<typeof handleAnalytics>[0];

		const res = await handleAnalytics(broken, "csrf", undefined);
		expect(res.status).toBe(500);
		expect(res.html).toContain("Analytics unavailable");
		expect(res.html).toContain("Back to home");
	});

	it("renders the page with a 200 for a healthy read", async () => {
		const res = await handleAnalytics(db(), "csrf-token", "2023");
		expect(res.status).toBe(200);
		expect(res.html).toMatch(/<option value="2023" selected>/);
	});
});
