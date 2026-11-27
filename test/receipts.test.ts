import { env, SELF, database, testConfig } from "./harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createCuotaApp } from "../src/app.js";
import type { AppEnv } from "../src/app-env.js";
import type { ReceiptStore, SqlDatabase } from "../src/ports.js";
import { MAX_RECEIPT_BYTES, receiptProblem, saveReceipt } from "../src/receipts.js";
import { MAX_UPLOAD_BYTES } from "../src/routes/scan.js";
import { getPage, initDb, postMultipart, refreshCsrf, signUpAndLogIn, type FormSession } from "./helpers.js";

/**
 * MIL-144: a photo captured with the add form is stored with its expense and can
 * be opened later by a signed-in member. The store is the harness's in-memory
 * ReceiptStore, so no bucket is touched.
 */

const db = () => env.DB;

beforeAll(initDb);

const ORIGIN = "http://example.com";

const expenseIdOf = async (description: string): Promise<number> =>
	(await db()
		.prepare("SELECT id FROM expenses WHERE description = ? ORDER BY id DESC LIMIT 1")
		.bind(description)
		.first<{ id: number }>())?.id ?? 0;

const expenseCount = async () =>
	Number((await db().prepare("SELECT COUNT(*) AS n FROM expenses").first<{ n: number }>())?.n ?? 0);

const receiptCount = async (expenseId: number) =>
	Number(
		(await db()
			.prepare("SELECT COUNT(*) AS n FROM receipts WHERE expense_id = ?")
			.bind(expenseId)
			.first<{ n: number }>())?.n ?? 0,
	);

/** A tiny stand-in for a captured photo. */
function photoFile(type = "image/png", name = "receipt.png"): File {
	return new File([new Uint8Array(64).fill(7)], name, { type });
}

/** The add form as multipart, with an optional photo. */
function addForm(session: FormSession, description: string, photo?: File): FormData {
	const form = new FormData();
	form.set("_csrf", session.csrf);
	form.set("amount", "12.50");
	form.set("description", description);
	form.set("payer", "me");
	form.set("date", "2026-01-01");
	form.set("category", "uncategorized");
	if (photo) form.set("photo", photo);
	return form;
}

/** Posts the add form to the harness app, following its redirect handling. */
async function addExpense(session: FormSession, description: string, photo?: File): Promise<Response> {
	return await postMultipart("/add", addForm(session, description, photo), session);
}

/**
 * Sends a request to an app other than the harness's (a host with no store, or
 * one whose store fails), folding any refreshed cookie back into the session.
 */
async function withApp(
	app: Hono<AppEnv>,
	session: FormSession,
	path: string,
	init: RequestInit,
): Promise<Response> {
	const res = await app.request(`${ORIGIN}${path}`, {
		...init,
		headers: { ...(init.headers ?? {}), cookie: session.cookie },
		redirect: "manual",
	});
	const refreshed = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
	if (refreshed) session.cookie = refreshed;
	return res;
}

describe("receiptProblem", () => {
	it("accepts the image types the reader accepts, and refuses the rest", () => {
		expect(receiptProblem({ type: "image/png", size: 100 })).toBeNull();
		expect(receiptProblem({ type: "image/jpeg", size: 100 })).toBeNull();
		expect(receiptProblem({ type: "text/plain", size: 100 })).toBe("type");
		expect(receiptProblem({ type: "application/pdf", size: 100 })).toBe("type");
	});

	it("refuses anything over the size cap", () => {
		expect(receiptProblem({ type: "image/png", size: MAX_RECEIPT_BYTES + 1 })).toBe("size");
	});
});

describe("receipt photos", () => {
	it("keeps the photo with the expense and serves it to a signed-in member", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		await signUpAndLogIn("richel@example.com");

		const added = await addExpense(session, "Taxi with receipt", photoFile());
		expect(added.status).toBe(303);

		const id = await expenseIdOf("Taxi with receipt");
		expect(id).toBeGreaterThan(0);

		const row = await db()
			.prepare("SELECT content_type, byte_size FROM receipts WHERE expense_id = ?")
			.bind(id)
			.first<{ content_type: string; byte_size: number }>();
		expect(row).toEqual({ content_type: "image/png", byte_size: 64 });

		// The home list links to it.
		await refreshCsrf(session, "/");
		expect(await getPage(session, "/")).toContain(`/expenses/${id}/photo`);

		// And the image itself comes back to a signed-in member.
		const served = await SELF.fetch(`${ORIGIN}/expenses/${id}/photo`, {
			headers: { cookie: session.cookie },
			redirect: "manual",
		});
		expect(served.status).toBe(200);
		expect(served.headers.get("content-type")).toBe("image/png");
		expect(served.headers.get("cache-control")).toBe("private, no-store");
		expect((await served.arrayBuffer()).byteLength).toBe(64);
	});

	it("refuses a file that is not an image, and stores nothing", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		const before = await expenseCount();

		const rejected = await addExpense(session, "Not an image", photoFile("text/plain", "notes.txt"));
		expect(rejected.status).toBe(422);
		// EJS escapes the apostrophe in "isn't", so match the tail of the message.
		expect(await rejected.text()).toContain("JPEG, PNG, GIF, or WebP image");
		expect(await expenseCount()).toBe(before);
	});

	it("refuses an oversized upload before it is read, and creates nothing", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		const before = await expenseCount();

		// Larger than the multipart body cap, so the pre-parse guard must reject
		// it before the CSRF middleware buffers the upload.
		const huge = new File([new Uint8Array(MAX_UPLOAD_BYTES)], "huge.png", { type: "image/png" });
		const res = await addExpense(session, "Huge receipt", huge);

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/add?photo=too-large");
		expect(await expenseCount()).toBe(before);

		// And the form explains why.
		expect(await getPage(session, "/add?photo=too-large")).toContain("larger than");
	});

	it("requires a session to read a receipt", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		await addExpense(session, "Private receipt", photoFile());
		const id = await expenseIdOf("Private receipt");

		const signedOut = await SELF.fetch(`${ORIGIN}/expenses/${id}/photo`, { redirect: "manual" });
		expect(signedOut.status).toBe(303);
		expect(signedOut.headers.get("location")).toBe("/login");
	});

	it("404s for an expense that has no receipt", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		await addExpense(session, "No photo here");
		const id = await expenseIdOf("No photo here");

		const missing = await SELF.fetch(`${ORIGIN}/expenses/${id}/photo`, {
			headers: { cookie: session.cookie },
			redirect: "manual",
		});
		expect(missing.status).toBe(404);
	});
});

describe("a host with no receipt store", () => {
	const noStore = createCuotaApp({
		database,
		config: testConfig,
		assets: { fetch: () => new Response("asset") },
	});

	it("hides the photo field and refuses a photo, storing nothing", async () => {
		const session = await signUpAndLogIn("mike@example.com");

		const page = await withApp(noStore, session, "/add", {});
		expect(await page.text()).not.toContain('name="photo"');

		const before = await expenseCount();
		const res = await withApp(noStore, session, "/add", {
			method: "POST",
			body: addForm(session, "No store", photoFile()),
		});
		expect(res.status).toBe(422);
		// EJS escapes the apostrophe, so match the tail of the message.
		expect(await res.text()).toContain("available on this deployment");
		expect(await expenseCount()).toBe(before);
	});
});

describe("when storing the photo fails", () => {
	const failing = createCuotaApp({
		database,
		config: testConfig,
		assets: { fetch: () => new Response("asset") },
		receipts: {
			async put() {
				throw new Error("bucket down");
			},
			async get() {
				return null;
			},
			async delete() {},
		},
	});

	it("keeps the expense, stores no receipt, and warns on the home page", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		const before = await expenseCount();

		const res = await withApp(failing, session, "/add", {
			method: "POST",
			body: addForm(session, "Photo that fails", photoFile()),
		});

		// The expense is recorded and the response says so; a failure here would
		// invite a retry that recorded the same cost twice.
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/?receipt=unavailable");
		expect(await expenseCount()).toBe(before + 1);

		const id = await expenseIdOf("Photo that fails");
		expect(await receiptCount(id)).toBe(0);

		const home = await withApp(failing, session, "/?receipt=unavailable", {});
		// EJS escapes the apostrophe, so match the tail of the warning.
		expect(await home.text()).toContain("was saved, but its receipt photo");
	});
});

describe("saveReceipt", () => {
	it("drops the object it just stored when the row cannot be written", async () => {
		const puts: string[] = [];
		const deletes: string[] = [];
		const store: ReceiptStore = {
			async put(key) {
				puts.push(key);
			},
			async get() {
				return null;
			},
			async delete(key) {
				deletes.push(key);
			},
		};
		const db = {
			prepare: (sql: string) => {
				const statement = {
					bind: () => statement,
					first: async () => null,
					all: async () => ({ results: [] }),
					run: async () => {
						if (sql.includes("INSERT INTO receipts")) throw new Error("disk full");
						return { meta: { changes: 0 } };
					},
				};
				return statement;
			},
			exec: async () => {},
			now: async () => "2026-01-01T00:00:00.000Z",
		} as unknown as SqlDatabase;

		await expect(
			saveReceipt(db, store, 7, { bytes: new Uint8Array(4), type: "image/png" }),
		).rejects.toThrow("disk full");

		expect(puts).toHaveLength(1);
		expect(deletes).toEqual(puts);
	});
});
