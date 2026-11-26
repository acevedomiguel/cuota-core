// Turning a model's reply about an invoice photo into the few values the
// add-expense form needs. All of it is pure — the network call lives in
// deepseek.ts — so the parsing and normalisation can be pinned without a
// request, the same way parseExpenseForm is.

import { parseAmountToCents } from "./calc.js";

/** What could be read off a single invoice photo. Any field may be unknown. */
export interface InvoiceReading {
	/** Integer cents for the amount due, or null when none could be read. */
	amountCents: number | null;
	/** Upper-cased ISO 4217 code (e.g. "HKD"), when the model reported one. */
	currency: string | null;
	/** A `YYYY-MM-DD` date as written on the invoice, or null. */
	date: string | null;
	/** The vendor or a short description, trimmed; null when absent. */
	vendor: string | null;
	/** The model's self-reported confidence in [0, 1], or null. */
	confidence: number | null;
}

/**
 * Trims an amount as it might appear on a photo into the plain decimal string
 * `parseAmountToCents` expects: drops currency symbols and spaces, and treats
 * commas as thousands separators (`HK$ 1,240.50` → `1240.50`). The household
 * is HKD, so a dot is always the decimal mark. Null when no digits remain.
 */
export function normalizeAmountText(raw: string): string | null {
	const cleaned = raw.replace(/[^\d.,]/g, "").replace(/,/g, "");
	return cleaned.length > 0 ? cleaned : null;
}

/** The first JSON object in a string, tolerating ```json fences and prose. */
function extractJsonObject(text: string): Record<string, unknown> | null {
	const trimmed = text.trim();
	const candidates = [trimmed];
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));
	for (const candidate of candidates) {
		try {
			const parsed: unknown = JSON.parse(candidate);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			/* try the next shape */
		}
	}
	return null;
}

function readAmount(value: unknown): number | null {
	if (typeof value !== "string" && typeof value !== "number") return null;
	const text = String(value);
	// An expense is always positive. A credit or refund read as a negative
	// amount is not an expense, so refuse it outright rather than stripping the
	// sign (which would flip the meaning) — the user types it in by hand.
	if (/[-−]/.test(text)) return null;
	const normalized = normalizeAmountText(text);
	return normalized === null ? null : parseAmountToCents(normalized);
}

function readCurrency(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const code = value.trim().toUpperCase();
	return /^[A-Z]{3}$/.test(code) ? code : null;
}

function readDate(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const date = value.trim();
	return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function readVendor(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const vendor = value.trim();
	return vendor.length > 0 ? vendor : null;
}

function readConfidence(value: unknown): number | null {
	// A missing confidence must stay unknown: `Number(null)` and `Number("")`
	// are both 0, which would read as a confident "low confidence" warning.
	if (value === null || value === undefined || value === "") return null;
	const confidence = Number(value);
	return Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : null;
}

/**
 * Parses the model's reply into a reading. Returns null only when no JSON
 * object can be found at all — the one case where nothing was read.
 */
export function parseInvoiceResponse(text: string): InvoiceReading | null {
	const obj = extractJsonObject(text);
	if (!obj) return null;
	return {
		amountCents: readAmount(obj.amount ?? obj.total ?? obj.amount_due),
		currency: readCurrency(obj.currency),
		date: readDate(obj.date),
		vendor: readVendor(obj.vendor ?? obj.description),
		confidence: readConfidence(obj.confidence),
	};
}
