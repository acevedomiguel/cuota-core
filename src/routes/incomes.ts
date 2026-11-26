// The salary history page. Entries are an insert-only timeline: each POST adds
// a row whose `created_at` is its effective moment, so a correction applies to
// expenses entered afterwards and never rewrites a past split. Every change
// also seals the running balance into a snapshot (the cache reads then fold
// only rows recorded since).

import { Hono } from "hono";
import { formatHKD, parseAmountToCents, ratioAt } from "../calc.js";
import { refreshSnapshot } from "../balance.js";
import { listUsers, type UserRow } from "../db.js";
import type { AppEnv } from "../app-env.js";
import { addIncome, listIncomes } from "../ledger.js";
import type { SqlDatabase } from "../ports.js";
import { renderView } from "../views.js";

export interface IncomeInput {
	userId: number;
	amountCents: number;
}

export type IncomeParseResult =
	| { ok: true; value: IncomeInput }
	| { ok: false; errors: Record<string, string> };

export function parseIncomeForm(
	fields: Record<string, unknown>,
	users: UserRow[],
): IncomeParseResult {
	const errors: Record<string, string> = {};

	const amountCents = parseAmountToCents(String(fields.amount ?? ""));
	if (amountCents === null) errors.amount = "Enter a monthly amount like 58000 or 58000.50.";

	const userId = Number(fields.userId ?? "");
	if (!users.some((u) => u.id === userId)) errors.userId = "Pick whose salary this is.";

	if (Object.keys(errors).length > 0) return { ok: false, errors };
	return { ok: true, value: { userId, amountCents: amountCents! } };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-11-23T08:15:00.000Z` → `Nov 23, 2026` (UTC date of the entry). */
function entryLabel(createdAt: string): string {
	const [date] = createdAt.split("T");
	const [year, month, day] = date.split("-");
	return `${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`;
}

/** The current salary per user, from their latest entry. */
function currentSalaries(incomes: { user_id: number; amount_cents: number }[], users: UserRow[]) {
	return users.map((u) => ({
		id: u.id,
		name: u.name,
		amountCents: incomes.filter((i) => i.user_id === u.id).at(-1)?.amount_cents ?? 0,
	}));
}

const app = new Hono<AppEnv>();

async function pageLocals(db: SqlDatabase, csrfToken: string, errors: Record<string, string> = {}, values: Record<string, unknown> = {}) {
	const [users, incomes] = await Promise.all([listUsers(db), listIncomes(db)]);
	const salaries = currentSalaries(incomes, users);
	const ratio = ratioAt(salaries[0]?.amountCents ?? 0, salaries[1]?.amountCents ?? 0);
	const pctA = Math.round(ratio.a * 100);
	return {
		title: "Salary",
		authenticated: true,
		active: "incomes",
		csrfToken,
		bothUsers: users.map((u) => ({ id: u.id, name: u.name })),
		// Each user's entries newest first, with a date label and HKD display.
		incomes: salaries.map((s, i) => ({
			name: s.name,
			tone: i === 0 ? "llama" : "mono",
			entries: incomes
				.filter((entry) => entry.user_id === s.id)
				.reverse()
				.map((entry) => ({ when: entryLabel(entry.created_at), amount: formatHKD(entry.amount_cents) })),
		})),
		salaries: salaries.map((s) => ({
			name: s.name,
			amount: s.amountCents > 0 ? formatHKD(s.amountCents) : "No salary yet",
		})),
		pct: [pctA, 100 - pctA],
		values,
		errors,
	};
}

app.get("/incomes", async (c) => {
	const user = c.get("user");
	if (!user) return c.redirect("/login", 303);
	return c.html(
		renderView(
			"incomes",
			await pageLocals(c.get("db"), c.get("csrfToken"), {}, { userId: String(user.id), amount: "" }),
		),
	);
});

app.post("/incomes", async (c) => {
	const user = c.get("user");
	if (!user) return c.redirect("/login", 303);
	const body = await c.req.parseBody();
	const users = await listUsers(c.get("db"));
	const result = parseIncomeForm(body, users);
	const values = { userId: String(body.userId ?? user.id), amount: String(body.amount ?? "") };

	if (!result.ok) {
		return c.html(
			renderView("incomes", await pageLocals(c.get("db"), c.get("csrfToken"), result.errors, values)),
			422,
		);
	}

	await addIncome(c.get("db"), result.value);
	// A salary change is a boundary: seal the balance in force right now, so
	// reads only fold what happens from here on. During onboarding there is
	// only one account, so there is no pair to seal yet — the first salary
	// from the second account seals the era instead.
	const ids = users.map((u) => u.id);
	if (ids.length === 2) {
		await refreshSnapshot(c.get("db"), ids[0], ids[1]);
	}
	return c.redirect("/incomes", 303);
});

export default app;
