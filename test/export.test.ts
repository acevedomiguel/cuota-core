import { env, SELF } from "./harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import { initDb, postForm, signUpAndLogIn, type FormSession } from "./helpers.js";

/**
 * MIL-30: the ledger downloads as a CSV over a date range, filtered on the
 * expense's own date, escaped, and safe to open in a spreadsheet.
 */

const db = () => env.DB;

beforeAll(initDb);

const ORIGIN = "http://example.com";

/** Adds an expense through the ordinary form. */
async function addExpense(
	session: FormSession,
	{ date, description, amount = "12.50" }: { date: string; description: string; amount?: string },
): Promise<void> {
	const res = await postForm("/add", { amount, description, payer: "me", date, category: "uncategorized" }, session);
	expect(res.status).toBe(303);
}

/** The CSV rows, without the byte-order mark and with the trailing CRLF dropped. */
async function rows(res: Response): Promise<string[]> {
	const text = (await res.text()).replace(/^\uFEFF/, "");
	return text.replace(/\r\n$/, "").split("\r\n");
}

const download = (path: string, session: FormSession) =>
	SELF.fetch(`${ORIGIN}${path}`, { headers: { cookie: session.cookie }, redirect: "manual" });

describe("CSV export", () => {
	it("requires a session", async () => {
		// A first signup, so the app has a user and the gate sends a stranger to
		// /login rather than the first-run /setup.
		await signUpAndLogIn("mike@example.com");
		const signedOut = await SELF.fetch(`${ORIGIN}/export`, { redirect: "manual" });
		expect(signedOut.status).toBe(303);
		expect(signedOut.headers.get("location")).toBe("/login");
	});

	it("downloads only the requested dates, with spreadsheet headers", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		await addExpense(session, { date: "2026-01-15", description: "January lunch" });
		await addExpense(session, { date: "2026-02-20", description: "February lunch" });

		const res = await download("/export?from=2026-01-01&to=2026-01-31", session);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
		expect(res.headers.get("content-disposition")).toBe(
			'attachment; filename="cuota-2026-01-01-to-2026-01-31.csv"',
		);
		expect(res.headers.get("cache-control")).toBe("private, no-store");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");

		const csv = await rows(res);
		expect(csv[0]).toBe("date,description,amount_hkd,payer,category");
		expect(csv).toHaveLength(2);
		expect(csv[1]).toBe("2026-01-15,January lunch,12.50,Test Person,Uncategorized");
	});

	it("returns just the header for a range with nothing in it", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		const res = await download("/export?from=2019-01-01&to=2019-12-31", session);
		expect(await rows(res)).toEqual(["date,description,amount_hkd,payer,category"]);
	});

	it("swaps a reversed range instead of returning nothing", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		await addExpense(session, { date: "2026-03-05", description: "March lunch" });

		const res = await download("/export?from=2026-03-31&to=2026-03-01", session);
		const csv = await rows(res);
		expect(csv).toHaveLength(2);
		expect(csv[1]).toContain("March lunch");
	});

	it("escapes a description and defuses a formula", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		await addExpense(session, { date: "2026-04-01", description: "Dinner, drinks" });
		await addExpense(session, { date: "2026-04-02", description: "=SUM(A1:A9)" });

		const csv = await rows(await download("/export?from=2026-04-01&to=2026-04-30", session));
		expect(csv[1]).toBe('2026-04-01,"Dinner, drinks",12.50,Test Person,Uncategorized');
		// The leading quote keeps a spreadsheet from evaluating it as a formula.
		expect(csv[2]).toBe("2026-04-02,'=SUM(A1:A9),12.50,Test Person,Uncategorized");
		// The amount stays numeric: guarding it would break a spreadsheet sum.
		expect(csv[1]).toContain(",12.50,");
		expect(csv[1]).not.toContain("'12.50");
	});

	it("exports one side of a range when only one end is given", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		await addExpense(session, { date: "2026-07-01", description: "July lunch" });
		await addExpense(session, { date: "2025-07-01", description: "Last year lunch" });

		const fromOnly = await rows(await download("/export?from=2026-01-01", session));
		expect(fromOnly.some((r) => r.includes("July lunch"))).toBe(true);
		expect(fromOnly.some((r) => r.includes("Last year lunch"))).toBe(false);

		const toOnly = await rows(await download("/export?to=2025-12-31", session));
		expect(toOnly.some((r) => r.includes("Last year lunch"))).toBe(true);
		expect(toOnly.some((r) => r.includes("July lunch"))).toBe(false);
	});

	it("names a reversed range by the dates it actually used", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		const res = await download("/export?from=2026-03-31&to=2026-03-01", session);
		expect(res.headers.get("content-disposition")).toBe(
			'attachment; filename="cuota-2026-03-01-to-2026-03-31.csv"',
		);
	});

	it("ignores an impossible calendar date rather than bounding on it", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		await addExpense(session, { date: "2026-02-28", description: "February lunch" });

		// 2026-02-30 rolls over to March; it must not become a range bound.
		const res = await download("/export?from=2026-02-30&to=2026-02-30", session);
		expect(res.status).toBe(200);
		expect((await rows(res)).some((r) => r.includes("February lunch"))).toBe(true);
	});

	it("never lets a range value reach the response headers", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		const res = await download("/export?from=2026-01-01%0d%0aX-Injected:%20yes&to=2026-12-31", session);
		expect(res.headers.get("content-disposition") ?? "").not.toMatch(/[\r\n]/);
		expect(res.headers.get("x-injected")).toBeNull();
	});

	it("orders the ledger oldest first", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		await addExpense(session, { date: "2026-09-01", description: "September lunch" });
		await addExpense(session, { date: "2026-08-01", description: "August lunch" });

		const csv = await rows(await download("/export", session));
		const august = csv.findIndex((r) => r.includes("August lunch"));
		const september = csv.findIndex((r) => r.includes("September lunch"));
		expect(august).toBeGreaterThan(0);
		expect(august).toBeLessThan(september);
	});

	it("exports the whole ledger when no range is given", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		const before = await rows(await download("/export", session));
		await addExpense(session, { date: "2026-05-01", description: "No range lunch" });

		const after = await rows(await download("/export", session));
		expect(after.length).toBe(before.length + 1);
		expect(after.some((r) => r.includes("No range lunch"))).toBe(true);
	});

	it("ignores a junk range rather than erroring", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		const res = await download("/export?from=not-a-date&to=2026-13-99", session);
		expect(res.status).toBe(200);
		expect((await rows(res))[0]).toBe("date,description,amount_hkd,payer,category");
	});
});
