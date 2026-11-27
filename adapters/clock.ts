/**
 * Strictly increasing clock wrapper for the database adapters.
 *
 * The app stamps every row with `db.now()` (millisecond ISO text). Two writes
 * in the same millisecond would otherwise share an instant, which makes an
 * income and an expense written back-to-back ambiguous: `incomeAsOf` resolves
 * the salary with `created_at <= expense.created_at`, so a salary change could
 * retroactively apply to an expense recorded a moment earlier.
 *
 * Wrapping the underlying clock guarantees that within one database instance
 * successive reads are strictly increasing: when the clock has not moved ahead
 * of the last returned value, it is bumped by one millisecond. Write order then
 * equals timestamp order, and the `id DESC` tiebreak in the timeline queries is
 * only a cosmetic final break instead of a silent semantic one.
 */

/** The millisecond ISO format every adapter returns, e.g. `2026-11-27T10:00:00.123Z`. */
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Asserts a clock value is in the documented format. */
function requireWellFormed(iso: string): string {
	if (!ISO_MS.test(iso)) {
		// A malformed clock value cannot be ordered or bumped; surface it rather
		// than fabricate a timestamp the database did not produce.
		throw new Error(`the database clock returned a malformed value ${JSON.stringify(iso)}`);
	}
	return iso;
}

/** One millisecond later, in the same millisecond ISO format. */
function bumpMs(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		// Unreachable when requireWellFormed passed; defensive for future callers.
		throw new Error(`cannot advance a malformed database clock value ${JSON.stringify(iso)}`);
	}
	return new Date(date.getTime() + 1).toISOString();
}

/**
 * Builds a strictly increasing clock from a database clock. The returned
 * function is safe to call repeatedly: it never returns a value at or before
 * the previous one, and it rejects a clock value that is not in the documented
 * millisecond format.
 */
export function makeStrictClock(clock: () => Promise<string>): () => Promise<string> {
	let last = "";
	return async () => {
		let next = requireWellFormed(await clock());
		if (last !== "" && next <= last) {
			// The database clock has not advanced past the last stamped value.
			// Bump one millisecond so ordering stays total.
			next = bumpMs(last);
		}
		last = next;
		return next;
	};
}
