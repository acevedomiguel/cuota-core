// The add-expense form: GET renders it with a live split preview, POST
// validates and stores integer cents. Validation is a pure function so it can
// be pinned without a request.

import { Hono } from "hono";
import { formatHKD, parseAmountToCents, sharesForExpense } from "../calc.js";
import { CATEGORY_OPTIONS, UNCATEGORIZED, isValidCategory } from "../categories.js";
import { listUsers, type UserRow } from "../db.js";
import type { AppEnv } from "../app-env.js";
import { createExpense, listExpenses, listIncomes } from "../ledger.js";
import type { SqlDatabase } from "../ports.js";
import { MAX_RECEIPT_BYTES, receiptProblem, saveReceipt } from "../receipts.js";
import { currentRatio, listSharingRules } from "../sharing.js";
import { todayInHongKong } from "../time.js";
import { renderView } from "../views.js";

export const DESCRIPTION_MAX = 120;

/**
 * What the add form says about a receipt photo. Kept here so the field error
 * and the pre-parse oversize message stay in step.
 */
const RECEIPT_MAX_MB = Math.round(MAX_RECEIPT_BYTES / (1024 * 1024));
export const PHOTO_TOO_LARGE = `That receipt photo is larger than ${RECEIPT_MAX_MB} MB. Try a smaller one.`;
export const PHOTO_NOT_AN_IMAGE = "That receipt photo isn't a JPEG, PNG, GIF, or WebP image.";
export const PHOTO_NO_STORE = "Receipt photos aren't available on this deployment. Save the expense without one.";

export interface ExpenseInput {
	date: string;
	description: string;
	amountCents: number;
	payerId: number;
	category: string;
}

export type ExpenseParseResult =
	| { ok: true; value: ExpenseInput }
	| { ok: false; errors: Record<string, string> };

/** `"me"` means the first user — callers list the signed-in user first. */
function resolvePayer(payer: string, users: UserRow[]): number | null {
	if (payer === "me") return users[0]?.id ?? null;
	return users.some((u) => u.id === Number(payer)) ? Number(payer) : null;
}

export function parseExpenseForm(
	fields: Record<string, unknown>,
	users: UserRow[],
	today: string,
): ExpenseParseResult {
	const errors: Record<string, string> = {};

	const amount = String(fields.amount ?? "");
	const amountCents = parseAmountToCents(amount);
	if (amountCents === null) errors.amount = "Enter an amount like 12.50.";

	const description = String(fields.description ?? "").trim();
	if (description.length === 0) errors.description = "Add a short description.";
	else if (description.length > DESCRIPTION_MAX) {
		errors.description = `Keep the description under ${DESCRIPTION_MAX} characters.`;
	}

	const date = String(fields.date ?? "");
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.date = "Pick a date.";
	else if (date > today) errors.date = "The date cannot be in the future.";

	const payerId = resolvePayer(String(fields.payer ?? ""), users);
	if (payerId === null) errors.payer = "Pick who paid.";

	// Missing category (older clients, direct posts) keeps the default bucket;
	// only a value that is neither the default nor a known id is an error.
	const rawCategory = String(fields.category ?? "").trim();
	const category = rawCategory === "" ? UNCATEGORIZED : rawCategory;
	if (!isValidCategory(category)) errors.category = "Pick a category.";

	if (Object.keys(errors).length > 0) return { ok: false, errors };
	return { ok: true, value: { date, description, amountCents: amountCents!, payerId: payerId!, category } };
}

/** Users with the signed-in one first, so `payer=me` is the viewer. */
async function orderedUsers(db: SqlDatabase, signedInId: number): Promise<UserRow[]> {
	const all = await listUsers(db);
	const mine = all.filter((u) => u.id === signedInId);
	const others = all.filter((u) => u.id !== signedInId);
	return [...mine, ...others];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-11-23` → `Nov 23`. */
function dateLabel(iso: string): string {
	const [, month, day] = iso.split("-");
	return `${MONTHS[Number(month) - 1]} ${Number(day)}`;
}

/**
 * Every local `add.ejs` needs. The ratio is the one in force *right now* —
 * the exact ratio this expense will be frozen with.
 */
export async function formLocals(db: SqlDatabase, signedInId: number) {
	const [users, incomes, recent, rules] = await Promise.all([
		orderedUsers(db, signedInId),
		listIncomes(db),
		listExpenses(db, 50),
		listSharingRules(db),
	]);
	const ratio = currentRatio(incomes, rules, users[0]?.id ?? 0, users[1]?.id ?? 0);
	const lowerId = (users[0]?.id ?? 0) < (users[1]?.id ?? 0);
	const preview = (amountCents: number) => {
		const { a, b } = sharesForExpense(amountCents, ratio.a, lowerId);
		return { a: formatHKD(a), b: formatHKD(b) };
	};
	const pctA = Math.round(ratio.a * 100);
	const descriptions = [...new Set(recent.map((r) => r.description))].slice(0, 8);
	return {
		users,
		ratio,
		pct: [pctA, 100 - pctA],
		lowerIsA: lowerId,
		preview,
		descriptions,
		categories: CATEGORY_OPTIONS,
		today: todayInHongKong(),
	};
}

/** The view locals the handlers share (only `values`/`errors`/`notice` differ). */
export function viewLocals(
	form: Awaited<ReturnType<typeof formLocals>>,
	csrfToken: string,
	values: Record<string, string>,
	errors: Record<string, string>,
	notice = "",
	/** Whether this host can keep a receipt photo; the field is hidden if not. */
	receipts = false,
) {
	return {
		title: "Add expense",
		authenticated: true,
		active: "add",
		csrfToken,
		notice,
		receipts,
		bothUsers: form.users.map((u) => ({ id: u.id, name: u.name })),
		ratio: [form.ratio.a, form.ratio.b],
		pct: form.pct,
		lowerIsA: form.lowerIsA,
		preview: form.preview(0),
		descriptions: form.descriptions,
		categories: form.categories,
		today: form.today,
		dateLabel: dateLabel(form.today),
		values,
		errors,
	};
}

const app = new Hono<AppEnv>();

app.get("/add", async (c) => {
	const user = c.get("user");
	if (!user) return c.redirect("/login", 303);
	const form = await formLocals(c.get("db"), user.id);
	const values = { amount: "", description: "", payer: "me", date: form.today, category: UNCATEGORIZED };
	// The pre-parse body cap (see app.ts) sends an oversized upload back here,
	// where the form can say why instead of the request failing outright.
	const errors: Record<string, string> =
		c.req.query("photo") === "too-large" ? { photo: PHOTO_TOO_LARGE } : {};
	return c.html(
		renderView("add", viewLocals(form, c.get("csrfToken"), values, errors, "", Boolean(c.get("receipts")))),
	);
});

app.post("/add", async (c) => {
	const user = c.get("user");
	if (!user) return c.redirect("/login", 303);
	const body = await c.req.parseBody();
	const form = await formLocals(c.get("db"), user.id);
	const result = parseExpenseForm(body, form.users, form.today);
	const store = c.get("receipts");

	const values = {
		amount: String(body.amount ?? ""),
		description: String(body.description ?? ""),
		payer: String(body.payer ?? "me"),
		date: String(body.date ?? form.today),
		category: String(body.category ?? UNCATEGORIZED),
	};

	// The optional receipt photo rides along with the same form. It is validated
	// before the expense is written, so a bad file never creates a half entry. A
	// photo the host cannot store is refused too, rather than silently dropped.
	const photo = body.photo;
	let photoFile: File | null = null;
	let photoError = "";
	if (photo instanceof File && photo.size > 0) {
		const problem = receiptProblem(photo);
		if (problem === "type") photoError = PHOTO_NOT_AN_IMAGE;
		else if (problem === "size") photoError = PHOTO_TOO_LARGE;
		else if (!store) photoError = PHOTO_NO_STORE;
		else photoFile = photo;
	}

	if (!result.ok || photoError !== "") {
		const base = result.ok ? {} : result.errors;
		const errors = photoError === "" ? base : { ...base, photo: photoError };
		return c.html(
			renderView("add", viewLocals(form, c.get("csrfToken"), values, errors, "", Boolean(store))),
			422,
		);
	}

	const expenseId = await createExpense(c.get("db"), result.value);

	// The expense is the point; the photo is a bonus. If storing it fails, keep
	// the expense and say so on the home page, rather than failing the request
	// and inviting a retry that would record the same cost twice.
	if (photoFile && store) {
		try {
			await saveReceipt(c.get("db"), store, expenseId, {
				bytes: new Uint8Array(await photoFile.arrayBuffer()),
				type: photoFile.type,
			});
		} catch {
			return c.redirect("/?receipt=unavailable", 303);
		}
	}
	return c.redirect("/", 303);
});

export default app;
