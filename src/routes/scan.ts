// Scan an invoice: take a photo, ask DeepSeek to read the amount, and land on
// the ordinary add-expense form pre-filled for the user to confirm. Nothing is
// written here — the ledger only ever changes when the user saves the form.

import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { UNCATEGORIZED } from "../categories.js";
import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES, readInvoice } from "../deepseek.js";
import type { AppEnv } from "../app-env.js";
import type { InvoiceReading } from "../invoice.js";
import { renderView } from "../views.js";
import { DESCRIPTION_MAX, formLocals, viewLocals } from "./expenses.js";

const app = new Hono<AppEnv>();

const MAX_MB = Math.round(MAX_IMAGE_BYTES / (1024 * 1024));

/**
 * The multipart body cap for a scan upload: the image limit plus headroom for
 * the multipart framing and the CSRF field. Enforced before the body is parsed
 * (see app.ts) so an oversized photo is refused without being buffered.
 */
export const MAX_UPLOAD_BYTES = MAX_IMAGE_BYTES + 1024 * 1024;

/** Shown when a chosen photo is over the image limit. */
export const OVERSIZE_MESSAGE = `That photo is larger than ${MAX_MB} MB. Try a smaller one.`;

/** The only locals the scan page needs (besides the shell locals). */
export function scanLocals(csrfToken: string, error = "") {
	return {
		title: "Scan an invoice",
		authenticated: true,
		active: "scan",
		csrfToken,
		error,
		maxMb: MAX_MB,
	};
}

/** Why a chosen file cannot be read, or null when it is acceptable. */
export function imageProblem(file: { type: string; size: number }): "type" | "size" | null {
	if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(file.type)) return "type";
	if (file.size > MAX_IMAGE_BYTES) return "size";
	return null;
}

/** Integer cents as a plain `1234.50` string the amount input accepts. */
function formatCentsPlain(cents: number): string {
	return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/**
 * The values the add form opens with. A date in the future or an unreadable
 * date falls back to today; an unread vendor is left for the user to fill in.
 */
export function prefillValues(reading: InvoiceReading, today: string): Record<string, string> {
	return {
		amount: reading.amountCents === null ? "" : formatCentsPlain(reading.amountCents),
		description: reading.vendor ? reading.vendor.slice(0, DESCRIPTION_MAX) : "",
		date: reading.date && reading.date <= today ? reading.date : today,
		payer: "me",
		category: UNCATEGORIZED,
	};
}

/** The line above the pre-filled form: what was read, and what to check. */
export function prefillNotice(reading: InvoiceReading): string {
	if (reading.amountCents === null) {
		return "Couldn't find an amount in that photo — check the fields and type it in.";
	}
	const currency = reading.currency && reading.currency !== "HKD" ? ` (the photo shows ${reading.currency})` : "";
	const unsure = reading.confidence !== null && reading.confidence < 0.6 ? " Low confidence — please double-check." : "";
	return `Amount read from the photo${currency}. Check it, then save.${unsure}`;
}

app.get("/scan", (c) => {
	const user = c.get("user");
	if (!user) return c.redirect("/login", 303);
	return c.html(renderView("scan", scanLocals(c.get("csrfToken"))));
});

app.post("/scan", async (c) => {
	const user = c.get("user");
	if (!user) return c.redirect("/login", 303);

	const body = await c.req.parseBody();
	const photo = body.photo;
	const back = (message: string, status: ContentfulStatusCode) =>
		c.html(renderView("scan", scanLocals(c.get("csrfToken"), message)), status);

	if (!(photo instanceof File) || photo.size === 0) {
		return back("Choose a photo of an invoice or receipt.", 422);
	}
	const problem = imageProblem(photo);
	if (problem === "type") return back("That file isn't a JPEG, PNG, GIF, or WebP image.", 422);
	if (problem === "size") return back(OVERSIZE_MESSAGE, 422);

	const result = await readInvoice(c.get("config").invoiceReader ?? null, { bytes: new Uint8Array(await photo.arrayBuffer()), mimeType: photo.type });
	if (!result.ok) {
		if (result.reason === "not-configured") {
			return back("Photo reading isn't set up on this deployment yet.", 503);
		}
		return back("Couldn't read that photo. Please try again, or add the expense by hand.", 502);
	}

	const form = await formLocals(c.get("db"), user.id);
	const values = prefillValues(result.reading, form.today);
	return c.html(renderView("add", viewLocals(form, c.get("csrfToken"), values, {}, prefillNotice(result.reading))));
});

export default app;
