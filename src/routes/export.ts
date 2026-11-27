// Downloading the ledger as CSV. A range export should be complete, so this
// reads the requested dates directly rather than the capped window the home and
// analytics pages fold — and it is a plain GET, so there is no CSRF to check.

import { Hono } from "hono";
import { categoryLabel } from "../categories.js";
import { formulaSafe, plainAmount, toCsv } from "../csv.js";
import { listUsers } from "../db.js";
import type { AppEnv } from "../app-env.js";
import { listExpensesBetween } from "../ledger.js";

const app = new Hono<AppEnv>();

const COLUMNS = ["date", "description", "amount_hkd", "payer", "category"];

/**
 * A `YYYY-MM-DD` query value, or undefined for absent, malformed, or impossible
 * (a shape-valid `2026-13-99` would otherwise become a range bound that quietly
 * selects the wrong rows).
 */
function dateParam(value: string | undefined): string | undefined {
	if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
	const parsed = new Date(`${value}T00:00:00.000Z`);
	return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? undefined : value;
}

/** The saved name, e.g. `cuota-2026-01-01-to-2026-12-31.csv`. */
function fileName(from: string | undefined, to: string | undefined): string {
	if (from === undefined && to === undefined) return "cuota-all.csv";
	const start = from ?? "start";
	const end = to ?? "end";
	return `cuota-${start}-to-${end}.csv`;
}

app.get("/export", async (c) => {
	const user = c.get("user");
	if (!user) return c.redirect("/login", 303);

	// Swap a reversed range rather than returning nothing: the person meant the
	// span between the two dates, whichever way they typed them.
	let from = dateParam(c.req.query("from"));
	let to = dateParam(c.req.query("to"));
	if (from !== undefined && to !== undefined && from > to) {
		[from, to] = [to, from];
	}

	const [expenses, users] = await Promise.all([
		listExpensesBetween(c.get("db"), from, to),
		listUsers(c.get("db")),
	]);
	const nameOf = new Map(users.map((u) => [u.id, u.name]));

	const rows: string[][] = [
		COLUMNS,
		...expenses.map((e) => [
			e.date,
			// Text columns go through the formula guard; the amount is ours.
			formulaSafe(e.description),
			plainAmount(e.amount_cents),
			formulaSafe(nameOf.get(e.payer_id) ?? `User ${e.payer_id}`),
			formulaSafe(categoryLabel(e.category)),
		]),
	];

	return new Response(toCsv(rows), {
		headers: {
			"content-type": "text/csv; charset=utf-8",
			"content-disposition": `attachment; filename="${fileName(from, to)}"`,
			// A household's spending: no shared cache may keep a copy.
			"cache-control": "private, no-store",
		},
	});
});

export default app;
