// The opening balance: the debt carried in from before the app started
// tracking. Exactly one ever exists (a partial unique index enforces it), and
// it can be deleted and re-entered, but never edited — a correction is a
// replacement.
//
// Direction is the whole risk here: "I owed her 300" and "she owed me 300" are
// the same amount with opposite signs. So the form never says from/to; it
// renders both real names and stores the row as from = the one who owed,
// to = the one who was owed.

import { Hono } from "hono";
import { formatHKD, parseAmountToCents } from "../calc.js";
import { listUsers, type UserRow } from "../db.js";
import type { AppEnv } from "../app-env.js";
import { addBalanceEvent, deleteOpeningBalance, getOpeningBalance } from "../ledger.js";
import type { SqlDatabase } from "../ports.js";
import { todayInHongKong } from "../time.js";
import { renderView } from "../views.js";

export interface OpeningInput {
	fromUserId: number;
	toUserId: number;
	amountCents: number;
}

export type OpeningParseResult =
	| { ok: true; value: OpeningInput }
	| { ok: false; errors: Record<string, string> };

/** `direction` is phrased from the signed-in user's point of view. */
export function parseOpeningForm(
	fields: Record<string, unknown>,
	viewer: UserRow,
	others: UserRow[],
): OpeningParseResult {
	const errors: Record<string, string> = {};
	const other = others[0];

	const amountCents = parseAmountToCents(String(fields.amount ?? ""));
	if (amountCents === null) errors.amount = "Enter an amount like 339.93 or 1200.";

	const direction = String(fields.direction ?? "");
	if (direction !== "i-owed-other" && direction !== "other-owed-me") {
		errors.direction = "Choose who owed whom.";
	}
	if (!other) errors.direction = "The second account has to sign up first.";

	if (Object.keys(errors).length > 0) return { ok: false, errors };

	// i-owed-other: I am the debtor. other-owed-me: they are.
	const from = direction === "i-owed-other" ? viewer : other!;
	const to = direction === "i-owed-other" ? other! : viewer;
	return { ok: true, value: { fromUserId: from.id, toUserId: to.id, amountCents: amountCents! } };
}

const app = new Hono<AppEnv>();

async function pageLocals(
	db: SqlDatabase,
	csrfToken: string,
	viewer: UserRow,
	errors: Record<string, string> = {},
	values: Record<string, unknown> = {},
) {
	const [all, opening] = await Promise.all([listUsers(db), getOpeningBalance(db)]);
	const others = all.filter((u) => u.id !== viewer.id);
	const nameOf = (id: number) => all.find((u) => u.id === id)?.name ?? "Someone";
	const other = others[0];
	return {
		title: "Opening balance",
		authenticated: true,
		active: "opening",
		csrfToken,
		viewer: { name: viewer.name },
		other: other ? { name: other.name } : null,
		opening: opening
			? {
					amount: formatHKD(opening.amount_cents),
					// Plain names, in the same "X owed Y" phrasing as the form.
					owedBy: nameOf(opening.from_user_id),
					owedTo: nameOf(opening.to_user_id),
					date: opening.date,
				}
			: null,
		values,
		errors,
	};
}

app.get("/opening-balance", async (c) => {
	const viewer = c.get("user");
	if (!viewer) return c.redirect("/login", 303);
	const [all] = await Promise.all([listUsers(c.get("db"))]);
	const others = all.filter((u) => u.id !== viewer.id);
	const direction = others.length > 0 ? "other-owed-me" : "";
	return c.html(
		renderView("opening", await pageLocals(c.get("db"), c.get("csrfToken"), viewer, {}, { amount: "", direction })),
	);
});

app.post("/opening-balance", async (c) => {
	const viewer = c.get("user");
	if (!viewer) return c.redirect("/login", 303);

	const body = await c.req.parseBody();
	const [all, existing] = await Promise.all([listUsers(c.get("db")), getOpeningBalance(c.get("db"))]);
	const others = all.filter((u) => u.id !== viewer.id);
	const values = { amount: String(body.amount ?? ""), direction: String(body.direction ?? "") };

	// The DB's partial unique index is the real guarantee; this is the friendly
	// path, and it also covers a row someone inserted directly.
	if (existing) {
		return c.html(
			renderView(
				"opening",
				await pageLocals(c.get("db"), c.get("csrfToken"), viewer, { direction: "An opening balance already exists. Delete it first to enter a new one." }, values),
			),
			422,
		);
	}

	const result = parseOpeningForm(body, viewer, others);
	if (!result.ok) {
		return c.html(
			renderView("opening", await pageLocals(c.get("db"), c.get("csrfToken"), viewer, result.errors, values)),
			422,
		);
	}

	await addBalanceEvent(c.get("db"), { ...result.value, date: todayInHongKong(), kind: "opening" });
	return c.redirect("/", 303);
});

app.post("/opening-balance/delete", async (c) => {
	const viewer = c.get("user");
	if (!viewer) return c.redirect("/login", 303);
	await deleteOpeningBalance(c.get("db"));
	return c.redirect("/opening-balance", 303);
});

export default app;
