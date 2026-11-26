import { env } from "./harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import type { UserRow } from "../src/db.js";
import { parseExpenseForm } from "../src/routes/expenses.js";
import { getPage, initDb, postForm, signUpAndLogIn } from "./helpers.js";

beforeAll(initDb);

const TODAY = "2026-11-23";

const users = [
	{ id: 1, email: "mike@example.com", name: "Mike", password_hash: "x", created_at: "" },
	{ id: 2, email: "richel@example.com", name: "Richel", password_hash: "x", created_at: "" },
] as UserRow[];

const valid = { amount: "12.50", description: "Taxi", payer: "me", date: TODAY };
const countExpenses = async () =>
	Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM expenses").first<{ n: number }>())?.n ?? 0);

describe("parseExpenseForm", () => {
	it("accepts a well-formed form, converting the amount to integer cents", () => {
		const result = parseExpenseForm(valid, users, TODAY);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({
				date: TODAY,
				description: "Taxi",
				amountCents: 1250,
				payerId: 1,
				category: "uncategorized",
			});
		}
	});

	it("defaults a missing category to the uncategorized bucket", () => {
		const result = parseExpenseForm(valid, users, TODAY);
		expect(result.ok && result.value.category).toBe("uncategorized");
	});

	it("keeps a known category, and rejects an unknown one", () => {
		const known = parseExpenseForm({ ...valid, category: "groceries" }, users, TODAY);
		expect(known.ok && known.value.category).toBe("groceries");
		const bogus = parseExpenseForm({ ...valid, category: "yachts" }, users, TODAY);
		expect(bogus.ok).toBe(false);
		if (!bogus.ok) expect(bogus.errors.category).toBeTruthy();
	});

	it("resolves an explicit payer id for the other user", () => {
		const result = parseExpenseForm({ ...valid, payer: "2" }, users, TODAY);
		expect(result.ok && result.value.payerId).toBe(2);
	});

	it("rejects a future date, an amount with 3 decimals, and an empty description", () => {
		const future = parseExpenseForm({ ...valid, date: "2999-01-01" }, users, TODAY);
		const decimals = parseExpenseForm({ ...valid, amount: "12.501" }, users, TODAY);
		const blank = parseExpenseForm({ ...valid, description: "   " }, users, TODAY);
		expect(future.ok).toBe(false);
		expect(decimals.ok).toBe(false);
		expect(blank.ok).toBe(false);
		if (!future.ok) expect(future.errors.date).toBeTruthy();
		if (!decimals.ok) expect(decimals.errors.amount).toBeTruthy();
		if (!blank.ok) expect(blank.errors.description).toBeTruthy();
	});

	it("rejects a non-positive, non-numeric, missing, or unknown-payer field", () => {
		expect(parseExpenseForm({ ...valid, amount: "0" }, users, TODAY).ok).toBe(false);
		expect(parseExpenseForm({ ...valid, amount: "-5" }, users, TODAY).ok).toBe(false);
		expect(parseExpenseForm({ ...valid, amount: "abc" }, users, TODAY).ok).toBe(false);
		expect(parseExpenseForm({ ...valid, amount: "" }, users, TODAY).ok).toBe(false);
		expect(parseExpenseForm({ ...valid, date: "" }, users, TODAY).ok).toBe(false);
		expect(parseExpenseForm({ ...valid, description: "x".repeat(121) }, users, TODAY).ok).toBe(false);
		expect(parseExpenseForm({ ...valid, payer: "99" }, users, TODAY).ok).toBe(false);
		expect(parseExpenseForm({ ...valid, payer: "not-a-user" }, users, TODAY).ok).toBe(false);
	});
});

describe("GET /add", () => {
	it("shows the form with the signed-in user preselected as payer", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		const html = await getPage(session, "/add");
		expect(html).toContain("new");
		expect(html).toMatch(/name="payer"[^>]*checked|checked[^>]*name="payer"/s);
		expect(html).toContain("_csrf");
	});

	it("offers a category select defaulting to Uncategorized", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		const html = await getPage(session, "/add");
		expect(html).toContain('name="category"');
		expect(html).toMatch(/<option value="uncategorized" selected>Uncategorized<\/option>/);
		expect(html).toContain('<option value="groceries"');
	});

	it("embeds the current salary ratio for the live split preview", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		const html = await getPage(session, "/add");
		expect(html).toMatch(/data-ratio-a="\d/);
		expect(html).toMatch(/data-ratio-b="\d/);
	});
});

describe("POST /add", () => {
	it("stores the expense in cents and redirects home", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		const res = await postForm("/add", { amount: "12.50", description: "Taxi ride", payer: "me", date: TODAY }, session);
		expect(res.status).toBe(303);
		const row = await env.DB.prepare("SELECT * FROM expenses WHERE description = ?")
			.bind("Taxi ride")
			.first<{ amount_cents: number }>();
		expect(row?.amount_cents).toBe(1250);
	});

	it("stores the chosen category, and defaults a missing one to uncategorized", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		await postForm("/add", { amount: "9", description: "Coffee beans", payer: "me", date: TODAY, category: "groceries" }, session);
		await postForm("/add", { amount: "9", description: "Mystery", payer: "me", date: TODAY }, session);
		const category = async (description: string) =>
			(
				await env.DB.prepare("SELECT category FROM expenses WHERE description = ?")
					.bind(description)
					.first<{ category: string }>()
			)?.category;
		expect(await category("Coffee beans")).toBe("groceries");
		expect(await category("Mystery")).toBe("uncategorized");
	});

	it("rejects a future date with a re-rendered error, storing nothing", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		const before = await countExpenses();
		const res = await postForm("/add", { amount: "10", description: "Time travel", payer: "me", date: "2999-01-01" }, session);
		expect(res.status).toBe(422);
		expect(await res.text()).toContain("Time travel");
		expect(await countExpenses()).toBe(before);
	});
});
