// The spending analytics page: a calendar year of expenses folded into a
// monthly trend, a ranking of the busiest months, and a category breakdown.
// All aggregation is pure (see ../analytics.js); this module only reads the
// ledger, resolves the requested year, and renders, so there is no client-side
// data fetch to wait on — a normal navigation is the loading state, and the
// year selector shows its own busy indicator while it navigates.

import { Hono } from "hono";
import { type AnalyticExpense, parseYearParam, summarize } from "../analytics.js";
import type { AppEnv } from "../app-env.js";
import { listExpenses } from "../ledger.js";
import type { SqlDatabase } from "../ports.js";
import { hongKongYear } from "../time.js";
import { renderView } from "../views.js";

/**
 * The analytics page folds the whole ledger, so it reads the same capped window
 * as the home page. A two-person ledger will not approach this in practice;
 * past it, the oldest expenses fall outside the charts — and outside the home
 * page's totals too, so the two views stay consistent rather than drifting.
 */
const EXPENSE_SCAN_LIMIT = 5000;

export interface AnalyticsResponse {
	status: 200 | 500;
	html: string;
}

/**
 * Builds the whole response for `GET /analytics`. Kept out of the route so the
 * failure branch is testable without fault-injecting the live binding: a ledger
 * read that throws renders the app's error page with a 500, and a healthy read
 * renders the page. A junk or absent `?year=` falls back to the current year
 * rather than erroring; a valid but empty year renders its empty state.
 */
export async function handleAnalytics(
	db: SqlDatabase,
	csrfToken: string,
	yearParam: string | undefined,
): Promise<AnalyticsResponse> {
	try {
		const rows = await listExpenses(db, EXPENSE_SCAN_LIMIT);
		const expenses: AnalyticExpense[] = rows.map((r) => ({
			date: r.date,
			amountCents: r.amount_cents,
			category: r.category,
		}));

		const currentYear = hongKongYear();
		const year = parseYearParam(yearParam) ?? currentYear;

		return {
			status: 200,
			html: renderView("analytics", {
				title: "Analytics",
				authenticated: true,
				active: "analytics",
				csrfToken,
				analytics: summarize(expenses, year, currentYear),
			}),
		};
	} catch (error) {
		// Keep the failure visible in the Worker logs; the visitor only sees the
		// friendly error page below.
		console.error("analytics: could not read the ledger", error);
		return {
			status: 500,
			html: renderView("error", {
				title: "Analytics unavailable",
				error: "We couldn't load your spending just now. Please try again in a moment.",
				authenticated: true,
			}),
		};
	}
}

const app = new Hono<AppEnv>();

app.get("/analytics", async (c) => {
	const user = c.get("user");
	if (!user) return c.redirect("/login", 303);
	const { status, html } = await handleAnalytics(c.get("db"), c.get("csrfToken"), c.req.query("year"));
	return c.html(html, status);
});

export default app;
