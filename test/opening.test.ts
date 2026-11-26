import { env } from "./harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import { getUserByEmail } from "../src/db.js";
import { getOpeningBalance, netBalanceEvents } from "../src/ledger.js";
import { getPage, initDb, postForm, signUpAndLogIn, type FormSession } from "./helpers.js";

const db = () => env.DB;

beforeAll(initDb);

const idOf = async (email: string) => (await getUserByEmail(db(), email))!.id;

let session: FormSession;
let mike = 0;
let richel = 0;

describe("opening balance entry", () => {
	beforeAll(async () => {
		// Real names matter here: the form has to phrase direction in the
		// household's own words, so the pin has to see "Mike owed Richel".
		session = await signUpAndLogIn("mike@example.com", "twelve-chars-ok", "Mike");
		await signUpAndLogIn("richel@example.com", "twelve-chars-ok", "Richel");
		mike = await idOf("mike@example.com");
		richel = await idOf("richel@example.com");
		await db().prepare("DELETE FROM balance_events").run();
	});

	it("shows the entry form with both real names, never abstract from/to", async () => {
		const html = await getPage(session, "/opening-balance");
		expect(html).toContain("Mike");
		expect(html).toContain("Richel");
		expect(html).toContain('name="_csrf"');
		expect(html).toContain('name="direction"');
		expect(html).not.toMatch(/from user|to user/i);
	});

	it("the dashboard offers the setup card before one exists", async () => {
		const html = await getPage(session, "/");
		expect(html).toContain("/opening-balance");
	});

	it("creates the opening balance with the direction the form expressed", async () => {
		// Mike signed in, choosing "Richel owed Mike" with 339.93.
		const res = await postForm("/opening-balance", { direction: "other-owed-me", amount: "339.93" }, session);
		expect(res.status).toBe(303);
		expect(await netBalanceEvents(db(), mike, richel)).toBe(33993);
		expect(await netBalanceEvents(db(), richel, mike)).toBe(-33993);
		const row = await getOpeningBalance(db());
		expect(row).not.toBeNull();
		expect(row!.from_user_id).toBe(richel);
		expect(row!.to_user_id).toBe(mike);
		expect(row!.amount_cents).toBe(33993);
	});

	it("the dashboard hides the setup card and shows the included amount once it exists", async () => {
		const html = await getPage(session, "/");
		expect(html).not.toContain("Started tracking mid-way");
		expect(html).toContain("opening balance");
		expect(html).toContain("339.93");
	});

	it("rejects a second opening balance", async () => {
		const res = await postForm("/opening-balance", { direction: "i-owed-other", amount: "10" }, session);
		expect(res.status).toBe(422);
		const rows = await db().prepare("SELECT COUNT(*) AS n FROM balance_events WHERE kind = 'opening'").first<{ n: number }>();
		expect(rows!.n).toBe(1);
	});

	it("rejects a second opening balance even if the first was inserted directly", async () => {
		await db().prepare("DELETE FROM balance_events").run();
		await db()
			.prepare("INSERT INTO balance_events (date, kind, from_user_id, to_user_id, amount_cents) VALUES (?, 'opening', ?, ?, ?)")
			.bind("2026-11-01", mike, richel, 5000)
			.run();
		const res = await postForm("/opening-balance", { direction: "i-owed-other", amount: "10" }, session);
		expect(res.status).toBe(422);
	});

	it("rejects a bad amount with a 422 and a message", async () => {
		await db().prepare("DELETE FROM balance_events").run();
		const res = await postForm("/opening-balance", { direction: "i-owed-other", amount: "1.001" }, session);
		expect(res.status).toBe(422);
		expect(await res.text()).toContain("amount");
		const rows = await db().prepare("SELECT COUNT(*) AS n FROM balance_events").first<{ n: number }>();
		expect(rows!.n).toBe(0);
	});

	it("rejects an unknown direction", async () => {
		const res = await postForm("/opening-balance", { direction: "sideways", amount: "10" }, session);
		expect(res.status).toBe(422);
	});

	it("delete removes the row so it can be re-entered", async () => {
		await db().prepare("DELETE FROM balance_events").run();
		await postForm("/opening-balance", { direction: "i-owed-other", amount: "250.50" }, session);
		expect(await netBalanceEvents(db(), richel, mike)).toBe(25050);

		const res = await postForm("/opening-balance/delete", {}, session);
		expect(res.status).toBe(303);
		expect(await getOpeningBalance(db())).toBeNull();
		expect(await netBalanceEvents(db(), richel, mike)).toBe(0);

		// And the balance reflects it, with the form back.
		const html = await getPage(session, "/");
		expect(html).toContain("Started tracking mid-way");
		expect(html).not.toContain("250.50");
	});

	it("flips the sign for the opposite direction", async () => {
		const res = await postForm("/opening-balance", { direction: "other-owed-me", amount: "1000" }, session);
		expect(res.status).toBe(303);
		expect(await netBalanceEvents(db(), richel, mike)).toBe(-100000);
		expect(await netBalanceEvents(db(), mike, richel)).toBe(100000);
	});
});
