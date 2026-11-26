// Pure split and balance math. Everything is integer cents; the only float
// operation is the ratio multiply, and it is rounded to a cent immediately, so
// no rounding error can accumulate across a ledger. No db, no clock: every
// input is a plain value, which is what makes this exhaustively testable.

/** An expense as the balance fold sees it: its frozen split keys on createdAt. */
export interface CalcExpense {
	amountCents: number;
	payerId: number;
	createdAt: string;
}

/**
 * The income ratio between two people, each input being that person's salary
 * in force (in cents). Neither earning → 50/50; only one earning → 100/0 to
 * that one. The two outputs always sum to 1.
 */
export function ratioAt(incomesA: number, incomesB: number): { a: number; b: number } {
	const total = incomesA + incomesB;
	if (total <= 0) return { a: 0.5, b: 0.5 };
	return { a: incomesA / total, b: incomesB / total };
}

/**
 * Parses a user-typed amount into integer cents: `12` → 1200, `12.5` → 1250,
 * `12.50` → 1250. Returns null for anything else — non-numeric input, more
 * than two decimal places, or a non-positive value. String-to-cents, never
 * `parseFloat`, so no binary-float representation error can slip into storage.
 */
export function parseAmountToCents(raw: string): number | null {
	const text = raw.trim();
	if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
	const [dollars, fraction = ""] = text.split(".");
	const cents = Number(dollars) * 100 + Number(fraction.padEnd(2, "0"));
	if (!Number.isSafeInteger(cents) || cents <= 0) return null;
	return cents;
}

/** One side's share of an amount, rounded to the nearest cent. */
export function splitCents(amountCents: number, ratio: number): number {
	return Math.round(amountCents * ratio);
}

/**
 * Both sides' shares of one expense. The shares always sum to exactly
 * `amountCents`: each side takes its floor, and the leftover cent (at most
 * one, since the ratios sum to 1) goes to the lower-`id` user — the same
 * tie-break every time, so the same inputs always yield the same split.
 */
export function sharesForExpense(
	amountCents: number,
	ratioA: number,
	aIsLowerId: boolean,
): { a: number; b: number } {
	const rawA = amountCents * ratioA;
	const rawB = amountCents - rawA;
	let a = Math.floor(rawA);
	let b = Math.floor(rawB);
	const leftover = amountCents - (a + b);
	if (leftover > 0) {
		if (aIsLowerId) a += leftover;
		else b += leftover;
	}
	return { a, b };
}

/**
 * The running balance from `userA`'s point of view (positive = A is owed),
 * summed over expenses plus the net of any balance events. Each expense is
 * split at the ratio in force when it was recorded — `incomeAsOf` resolves
 * that from the salary timeline — so a later salary change never re-splits an
 * expense already in the ledger.
 */
export function balanceCents(
	expenses: CalcExpense[],
	incomeAsOf: (userId: number, asOf: string) => number,
	userA: number,
	userB: number,
	netEventsCents = 0,
): number {
	const aIsLowerId = userA < userB;
	let paidA = 0;
	let owedA = 0;
	for (const expense of expenses) {
		const ratio = ratioAt(incomeAsOf(userA, expense.createdAt), incomeAsOf(userB, expense.createdAt));
		const { a } = sharesForExpense(expense.amountCents, ratio.a, aIsLowerId);
		if (expense.payerId === userA) paidA += expense.amountCents;
		owedA += a;
	}
	return paidA - owedA + netEventsCents;
}

/** Formats integer cents as `HK$ 1,240.50`; negatives as `-HK$ 5.00`. */
export function formatHKD(cents: number): string {
	const negative = cents < 0;
	const abs = Math.abs(cents);
	const dollars = Math.floor(abs / 100);
	const remainder = abs % 100;
	const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return `${negative ? "-" : ""}HK$ ${grouped}.${String(remainder).padStart(2, "0")}`;
}
