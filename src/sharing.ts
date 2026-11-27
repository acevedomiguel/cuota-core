// How expenses are split. The default is the salary ratio; a couple may instead
// fix a percentage for one partner, with the other taking the remainder.
//
// Rules are an insert-only timeline, exactly like salaries: a row is effective
// from its `created_at`, so a change never rewrites an expense already recorded
// and the split frozen at entry stays frozen. A database with no rule at all
// behaves as it always has — the salary ratio.

import { ratioAt } from "./calc.js";
import type { IncomeRow } from "./ledger.js";
import type { SqlDatabase } from "./ports.js";

/** The full range of a percentage, in basis points (100.00%). */
export const MAX_BPS = 10000;

export type SharingMode = "salary" | "fixed";

export interface SharingRuleRow {
	id: number;
	mode: SharingMode;
	/** The partner the fixed percentage applies to; null in salary mode. */
	subject_user_id: number | null;
	/** Basis points; null in salary mode. */
	percentage_bps: number | null;
	created_at: string;
}

export interface NewSharingRule {
	mode: SharingMode;
	subjectUserId?: number;
	percentageBps?: number;
	/** Test seam: forces `created_at`; defaults to the database clock. */
	createdAt?: string;
}

/** Records a rule. A fixed rule must name its subject and a 0..100% value. */
export async function addSharingRule(db: SqlDatabase, rule: NewSharingRule): Promise<number> {
	if (rule.mode === "fixed") {
		if (rule.subjectUserId === undefined || rule.percentageBps === undefined) {
			throw new Error("a fixed sharing rule needs a subject and a percentage");
		}
		if (!Number.isInteger(rule.percentageBps) || rule.percentageBps < 0 || rule.percentageBps > MAX_BPS) {
			throw new Error(`percentage_bps must be a whole number between 0 and ${MAX_BPS}`);
		}
	}

	const createdAt = rule.createdAt ?? (await db.now());
	const row = await db
		.prepare(
			`INSERT INTO sharing_rules (mode, subject_user_id, percentage_bps, created_at)
			 VALUES (?, ?, ?, ?) RETURNING id`,
		)
		.bind(
			rule.mode,
			rule.mode === "fixed" ? rule.subjectUserId! : null,
			rule.mode === "fixed" ? rule.percentageBps! : null,
			createdAt,
		)
		.first<{ id: number }>();
	if (!row) throw new Error("could not record the sharing rule");
	return row.id;
}

/** The whole rule timeline, oldest first. */
export async function listSharingRules(db: SqlDatabase): Promise<SharingRuleRow[]> {
	const { results } = await db
		.prepare("SELECT * FROM sharing_rules ORDER BY created_at ASC, id ASC")
		.all<SharingRuleRow>();
	return results ?? [];
}

/** The rule in force at an instant: the latest recorded at or before it. */
export function ruleAt(rules: SharingRuleRow[], asOf: string): SharingRuleRow | null {
	let found: SharingRuleRow | null = null;
	for (const rule of rules) if (rule.created_at <= asOf) found = rule;
	return found;
}

/** A rule whose percentage can be applied to the given pair. */
function usableFixedRule(rule: SharingRuleRow | null, userA: number, userB: number): rule is SharingRuleRow {
	return (
		rule?.mode === "fixed" &&
		rule.percentage_bps !== null &&
		rule.subject_user_id !== null &&
		(rule.subject_user_id === userA || rule.subject_user_id === userB)
	);
}

/** One partner's salary in force at an instant, from the whole timeline. */
function salaryAt(incomes: IncomeRow[], userId: number, asOf: string): number {
	let value = 0;
	for (const row of incomes) {
		if (row.user_id === userId && row.created_at <= asOf) value = row.amount_cents;
	}
	return value;
}

/**
 * The per-user weight a split is computed from at a given instant, preserving
 * `balanceCents`'s contract: in salary mode it is the salary in force, and in
 * fixed mode it is the subject's percentage and the other partner's remainder,
 * in basis points. `ratioAt` only uses the ratio of the two, so both modes share
 * the same arithmetic and the same cent rounding.
 */
export function sharingResolver(
	incomes: IncomeRow[],
	rules: SharingRuleRow[],
	userA: number,
	userB: number,
): (userId: number, asOf: string) => number {
	return (userId, asOf) => {
		const rule = ruleAt(rules, asOf);
		if (usableFixedRule(rule, userA, userB)) {
			return rule.subject_user_id === userId ? rule.percentage_bps! : MAX_BPS - rule.percentage_bps!;
		}
		return salaryAt(incomes, userId, asOf);
	};
}

/**
 * The weights in force right now — the last rule, or the latest salaries when
 * there is none. Used for the "current split" the pages display and the live
 * preview on the add form.
 */
export function currentWeights(
	incomes: IncomeRow[],
	rules: SharingRuleRow[],
	userA: number,
	userB: number,
): { a: number; b: number } {
	const rule = rules.at(-1) ?? null;
	if (usableFixedRule(rule, userA, userB)) {
		const percentage = rule.percentage_bps!;
		return {
			a: rule.subject_user_id === userA ? percentage : MAX_BPS - percentage,
			b: rule.subject_user_id === userB ? percentage : MAX_BPS - percentage,
		};
	}
	return { a: salaryAt(incomes, userA, "\uffff"), b: salaryAt(incomes, userB, "\uffff") };
}

/** The split in force right now, as a ratio. */
export function currentRatio(
	incomes: IncomeRow[],
	rules: SharingRuleRow[],
	userA: number,
	userB: number,
): { a: number; b: number } {
	const { a, b } = currentWeights(incomes, rules, userA, userB);
	return ratioAt(a, b);
}
