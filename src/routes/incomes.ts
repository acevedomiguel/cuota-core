// The salary and sharing page. Both are insert-only timelines: each POST adds a
// row whose `created_at` is its effective moment, so a correction applies to
// expenses entered afterwards and never rewrites a past split. Every change
// also seals the running balance into a snapshot (the cache reads then fold
// only rows recorded since).

import { Hono } from "hono";
import { formatHKD, parseAmountToCents } from "../calc.js";
import { refreshSnapshot } from "../balance.js";
import { listUsers, type UserRow } from "../db.js";
import type { AppEnv } from "../app-env.js";
import { addIncome, listIncomes } from "../ledger.js";
import type { SqlDatabase } from "../ports.js";
import { addSharingRule, currentRatio, listSharingRules, type SharingRuleRow } from "../sharing.js";
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

/** Basis points → the shortest decimal percentage, e.g. 6250 → "62.5". */
export function formatPercentage(bps: number): string {
	const whole = Math.trunc(bps / 100);
	const fraction = bps % 100;
	if (fraction === 0) return String(whole);
	return `${whole}.${String(fraction).padStart(2, "0").replace(/0$/, "")}`;
}

/**
 * Parses a user-typed percentage into basis points: `50` → 5000, `62.5` →
 * 6250. Returns null for anything else — non-numeric input, more than two
 * decimals, or a value outside 0..100. String-to-basis-points, never
 * `parseFloat`, so no binary-float representation error can slip into storage.
 */
export function parsePercentageToBps(raw: string): number | null {
	const text = raw.trim();
	if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return null;
	const [whole, fraction = ""] = text.split(".");
	const bps = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
	if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10000) return null;
	return bps;
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

/** One rule, as a line a person reads. */
function ruleLabel(rule: SharingRuleRow, users: UserRow[]): string {
	if (rule.mode !== "fixed" || rule.percentage_bps === null || rule.subject_user_id === null) {
		return "Salary ratio";
	}
	const name = users.find((u) => u.id === rule.subject_user_id)?.name ?? "Someone";
	return `${formatPercentage(rule.percentage_bps)}% to ${name}`;
}

const app = new Hono<AppEnv>();

async function pageLocals(
	db: SqlDatabase,
	csrfToken: string,
	errors: Record<string, string> = {},
	values: Record<string, unknown> = {},
	sharingValues: Record<string, unknown> = {},
) {
	const [users, incomes, rules] = await Promise.all([listUsers(db), listIncomes(db), listSharingRules(db)]);
	const salaries = currentSalaries(incomes, users);
	const ratio = currentRatio(incomes, rules, salaries[0]?.id ?? 0, salaries[1]?.id ?? 0);
	const pctA = Math.round(ratio.a * 100);
	const latest = rules.at(-1) ?? null;
	const fixed = latest?.mode === "fixed" ? latest : null;
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
		// The sharing rule in force, the form's defaults, and the timeline.
		sharing: {
			mode: latest?.mode ?? "salary",
			summary: latest ? ruleLabel(latest, users) : "Salary ratio",
			subjectUserId: fixed?.subject_user_id ?? salaries[0]?.id ?? 0,
			percentage: fixed?.percentage_bps != null ? formatPercentage(fixed.percentage_bps) : "50",
			values: sharingValues,
			entries: rules
				.slice()
				.reverse()
				.map((rule) => ({ when: entryLabel(rule.created_at), label: ruleLabel(rule, users) })),
		},
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
	// Entering a salary while a fixed percentage is in force switches the couple
	// back to salary sharing: the salary is the rule they just chose.
	const rules = await listSharingRules(c.get("db"));
	if (rules.at(-1)?.mode === "fixed") {
		await addSharingRule(c.get("db"), { mode: "salary" });
	}
	// A sharing change is a boundary: seal the balance in force right now, so
	// reads only fold what happens from here on. During onboarding there is
	// only one account, so there is no pair to seal yet — the first change
	// from the second account seals the era instead.
	const ids = users.map((u) => u.id);
	if (ids.length === 2) {
		await refreshSnapshot(c.get("db"), ids[0], ids[1]);
	}
	return c.redirect("/incomes", 303);
});

/** Switches the split to a fixed percentage, or back to the salary ratio. */
app.post("/incomes/sharing", async (c) => {
	const user = c.get("user");
	if (!user) return c.redirect("/login", 303);
	const body = await c.req.parseBody();
	const users = await listUsers(c.get("db"));
	const mode = String(body.mode ?? "fixed") === "salary" ? "salary" : "fixed";
	const sharingValues = {
		subjectUserId: String(body.subjectUserId ?? user.id),
		percentage: String(body.percentage ?? ""),
	};

	if (mode === "salary") {
		await addSharingRule(c.get("db"), { mode: "salary" });
	} else {
		const errors: Record<string, string> = {};
		const percentageBps = parsePercentageToBps(String(body.percentage ?? ""));
		if (percentageBps === null) errors.percentage = "Enter a percentage between 0 and 100.";
		const subjectUserId = Number(body.subjectUserId ?? "");
		if (!users.some((u) => u.id === subjectUserId)) {
			errors.subjectUserId = "Pick who the percentage applies to.";
		}
		if (Object.keys(errors).length > 0) {
			return c.html(
				renderView("incomes", await pageLocals(c.get("db"), c.get("csrfToken"), errors, {}, sharingValues)),
				422,
			);
		}
		await addSharingRule(c.get("db"), { mode: "fixed", subjectUserId, percentageBps: percentageBps! });
	}

	const ids = users.map((u) => u.id);
	if (ids.length === 2) {
		await refreshSnapshot(c.get("db"), ids[0], ids[1]);
	}
	return c.redirect("/incomes", 303);
});

export default app;
