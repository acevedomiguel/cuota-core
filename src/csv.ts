// A CSV writer for the export. Pure and small: it owns the two things that are
// easy to get wrong — quoting a field that contains a comma, a quote, or a line
// break, and stopping a spreadsheet from evaluating a description as a formula.

/**
 * Excel, Numbers, and Sheets all evaluate a field that starts with one of these.
 * Tab and carriage return are on the list too — a spreadsheet trims them before
 * deciding, so a value that only looks inert would still be evaluated.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Defuses a value that a spreadsheet would treat as a formula by prefixing a
 * single quote, which those programs read as "this is text" and do not display.
 * Applied to text columns only: a number column is ours, not the user's.
 */
export function formulaSafe(value: string): string {
	return FORMULA_START.test(value) ? `'${value}` : value;
}

/** Quotes a field only when it must be, doubling any quote inside it. */
export function csvField(value: string): string {
	return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Rows of already-typed fields to one CSV file. CRLF line endings and a leading
 * byte-order mark, so Excel opens it as UTF-8 and lays out the columns on the
 * first try. Callers pass text through `formulaSafe` first.
 */
export function toCsv(rows: readonly (readonly string[])[]): string {
	return `\uFEFF${rows.map((row) => row.map(csvField).join(",")).join("\r\n")}\r\n`;
}

/** Integer cents as a plain `12.50` a spreadsheet can add up. */
export function plainAmount(cents: number): string {
	const sign = cents < 0 ? "-" : "";
	const abs = Math.abs(cents);
	return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
