// Pure aggregation for the spending analytics page: a calendar year of
// expenses folded into a monthly trend, a ranking of the busiest months, and a
// category breakdown. Everything is integer cents and derived from the same
// expense rows the rest of the app uses, so the totals reconcile by
// construction. No db, no clock: the selected year and the "current year" are
// plain inputs, which is what makes this exhaustively testable.

import { formatHKD } from "./calc.js";
import { UNCATEGORIZED, categoryLabel } from "./categories.js";

export interface AnalyticExpense {
	date: string;
	amountCents: number;
	category: string;
}

export interface MonthPoint {
	month: number;
	/** Three-letter label, `Jan`. */
	label: string;
	/** Full label, `January`. */
	longLabel: string;
	totalCents: number;
	formatted: string;
	/** Bar height as a whole percent of the busiest month (0 for an empty year). */
	heightPct: number;
	isZero: boolean;
}

export interface RankedMonth {
	rank: number;
	month: number;
	longLabel: string;
	totalCents: number;
	formatted: string;
}

export interface CategorySlice {
	id: string;
	label: string;
	totalCents: number;
	formatted: string;
	/** Share of the year's spending, as a whole percent; the set sums to 100. */
	pct: number;
}

export interface Analytics {
	year: number;
	/** Selectable years: every year with data, the current year, and this one. */
	years: number[];
	hasData: boolean;
	transactionCount: number;
	totalCents: number;
	totalFormatted: string;
	months: MonthPoint[];
	/** The months with spending, busiest first. */
	topMonths: RankedMonth[];
	/** Category totals, largest first. */
	categories: CategorySlice[];
}

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_LONG = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/** The four-digit year of an ISO date, or null when the date is malformed. */
function yearOf(date: string): number | null {
	const match = /^(\d{4})-\d{2}-\d{2}/.exec(date);
	return match ? Number(match[1]) : null;
}

/**
 * A `?year=` value as a usable calendar year, or null to fall back to the
 * current one. Only a plain four-digit year in a sane range is accepted, so a
 * junk query string can never produce a nonsense period or an error.
 */
export function parseYearParam(raw: string | undefined): number | null {
	if (!raw || !/^\d{4}$/.test(raw)) return null;
	const year = Number(raw);
	return year >= 1970 && year <= 9999 ? year : null;
}

/** Distinct calendar years present in the data, newest first. */
export function yearsWithData(expenses: AnalyticExpense[]): number[] {
	const years = new Set<number>();
	for (const e of expenses) {
		const year = yearOf(e.date);
		if (year !== null) years.add(year);
	}
	return [...years].sort((a, b) => b - a);
}

/**
 * Whole-number percentages that sum to exactly 100, using the largest-remainder
 * method so the rounded shares still add up (a plain `Math.round` leaves the
 * column reading 99% or 101%). Ties go to the earlier entry, so the result is
 * deterministic.
 */
function distributePct(parts: number[], total: number): number[] {
	if (total <= 0 || parts.length === 0) return parts.map(() => 0);
	const exact = parts.map((p) => (p / total) * 100);
	const result = exact.map((v) => Math.floor(v));
	let remainder = 100 - result.reduce((a, b) => a + b, 0);
	const order = exact
		.map((v, i) => ({ i, frac: v - Math.floor(v) }))
		.sort((a, b) => b.frac - a.frac || a.i - b.i);
	for (let k = 0; k < order.length && remainder > 0; k += 1) {
		result[order[k].i] += 1;
		remainder -= 1;
	}
	return result;
}

/**
 * Fold every expense recorded in `year` into the analytics page's view model.
 * `currentYear` is the household's current year, so an empty ledger still
 * offers a year to look at.
 */
export function summarize(expenses: AnalyticExpense[], year: number, currentYear: number): Analytics {
	const inYear = expenses.filter((e) => yearOf(e.date) === year);
	const totalCents = inYear.reduce((sum, e) => sum + e.amountCents, 0);

	const monthTotals = new Array<number>(12).fill(0);
	for (const e of inYear) {
		const month = Number(e.date.slice(5, 7));
		if (month >= 1 && month <= 12) monthTotals[month - 1] += e.amountCents;
	}
	const maxMonth = Math.max(0, ...monthTotals);

	const months: MonthPoint[] = monthTotals.map((cents, i) => ({
		month: i + 1,
		label: MONTH_LABELS[i],
		longLabel: MONTH_LONG[i],
		totalCents: cents,
		formatted: formatHKD(cents),
		heightPct: maxMonth > 0 ? Math.round((cents / maxMonth) * 100) : 0,
		isZero: cents === 0,
	}));

	const topMonths: RankedMonth[] = months
		.filter((m) => !m.isZero)
		.sort((a, b) => b.totalCents - a.totalCents || a.month - b.month)
		.map((m, i) => ({
			rank: i + 1,
			month: m.month,
			longLabel: m.longLabel,
			totalCents: m.totalCents,
			formatted: m.formatted,
		}));

	const byCategory = new Map<string, number>();
	for (const e of inYear) {
		const key = e.category.length > 0 ? e.category : UNCATEGORIZED;
		byCategory.set(key, (byCategory.get(key) ?? 0) + e.amountCents);
	}
	const entries = [...byCategory.entries()].sort(
		(a, b) => b[1] - a[1] || categoryLabel(a[0]).localeCompare(categoryLabel(b[0])),
	);
	const pcts = distributePct(entries.map(([, cents]) => cents), totalCents);
	const categories: CategorySlice[] = entries.map(([id, cents], i) => ({
		id,
		label: categoryLabel(id),
		totalCents: cents,
		formatted: formatHKD(cents),
		pct: pcts[i],
	}));

	const yearSet = new Set<number>(yearsWithData(expenses));
	yearSet.add(currentYear);
	yearSet.add(year);
	const years = [...yearSet].sort((a, b) => b - a);

	return {
		year,
		years,
		hasData: inYear.length > 0,
		transactionCount: inYear.length,
		totalCents,
		totalFormatted: formatHKD(totalCents),
		months,
		topMonths,
		categories,
	};
}
