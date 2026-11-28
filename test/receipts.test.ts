import { env, SELF, database, receiptStore, testConfig } from "./harness.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { fileReceipts, memoryReceipts } from "../adapters/receipts.js";
import { createCuotaApp } from "../src/app.js";
import type { AppEnv } from "../src/app-env.js";
import type { ReceiptStore, SqlDatabase } from "../src/ports.js";
import {
	MAX_RECEIPT_BYTES,
	MAX_RETENTION_DAYS,
	expensesWithReceipts,
	pruneReceipts,
	receiptCutoff,
	receiptProblem,
	saveReceipt,
} from "../src/receipts.js";
import { getPage, initDb, postForm, refreshCsrf, signUpAndLogIn, type FormSession } from "./helpers.js";

/**
 * The receipt-storage module. MIL-156 left it without a writer — the add form no
 * longer takes a photo — so these tests drive `saveReceipt` directly. The
 * storage itself is retired in MIL-185.
 */

const db = () => env.DB;

beforeAll(initDb);

const ORIGIN = "http://example.com";

const expenseIdOf = async (description: string): Promise<number> =>
	(await db()
		.prepare("SELECT id FROM expenses WHERE description = ? ORDER BY id DESC LIMIT 1")
		.bind(description)
		.first<{ id: number }>())?.id ?? 0;

const receiptCount = async (expenseId: number) =>
	Number(
		(await db()
			.prepare("SELECT COUNT(*) AS n FROM receipts WHERE expense_id = ?")
			.bind(expenseId)
			.first<{ n: number }>())?.n ?? 0,
	);

/** Adds an expense by hand, which is the only way in now. */
async function addExpense(session: FormSession, description: string): Promise<number> {
	const res = await postForm(
		"/add",
		{ amount: "12.50", description, payer: "me", date: "2026-01-01", category: "uncategorized" },
		session,
	);
	expect(res.status).toBe(303);
	return await expenseIdOf(description);
}

/**
 * Sends a request to an app other than the harness's (the retention-window app),
 * folding any refreshed cookie back into the session.
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

describe("serving a stored receipt", () => {
	it("serves it to a signed-in member and links it from home", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		const id = await addExpense(session, "Taxi with receipt");
		await saveReceipt(database, receiptStore, id, {
			bytes: new Uint8Array(64).fill(7),
			type: "image/png",
		});

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
		expect(served.headers.get("x-content-type-options")).toBe("nosniff");
		expect((await served.arrayBuffer()).byteLength).toBe(64);
	});

	it("requires a session to read a receipt", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		const id = await addExpense(session, "Private receipt");
		await saveReceipt(database, receiptStore, id, { bytes: new Uint8Array(8), type: "image/png" });

		const signedOut = await SELF.fetch(`${ORIGIN}/expenses/${id}/photo`, { redirect: "manual" });
		expect(signedOut.status).toBe(303);
		expect(signedOut.headers.get("location")).toBe("/login");
	});

	it("404s for an expense that has no receipt", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		const id = await addExpense(session, "No photo here");

		const missing = await SELF.fetch(`${ORIGIN}/expenses/${id}/photo`, {
			headers: { cookie: session.cookie },
			redirect: "manual",
		});
		expect(missing.status).toBe(404);
	});
});

describe("the add form", () => {
	it("no longer offers a photo, and takes a plain form post", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		const html = await getPage(session, "/add");
		expect(html).not.toContain('name="photo"');
		expect(html).toContain('href="/scan"');

		const id = await addExpense(session, "Typed in by hand");
		expect(await receiptCount(id)).toBe(0);
	});
});

describe("saveReceipt", () => {
	it("replaces an earlier photo and drops the superseded object", async () => {
		const store = memoryReceipts();
		const deletes: string[] = [];
		const recording: ReceiptStore = {
			put: (key, body, type) => store.put(key, body, type),
			get: (key) => store.get(key),
			delete: async (key) => {
				deletes.push(key);
				await store.delete(key);
			},
		};

		const session = await signUpAndLogIn("mike@example.com");
		const id = await addExpense(session, "Replace me");

		const keyOf = async () =>
			(await db()
				.prepare("SELECT object_key FROM receipts WHERE expense_id = ?")
				.bind(id)
				.first<{ object_key: string }>())?.object_key;

		await saveReceipt(database, recording, id, { bytes: new Uint8Array(8), type: "image/png" });
		const first = await keyOf();
		expect(first).toBeTruthy();

		await saveReceipt(database, recording, id, { bytes: new Uint8Array(16), type: "image/jpeg" });
		const second = await keyOf();

		expect(second).not.toBe(first);
		expect(deletes).toEqual([first]);
		// The superseded bytes are gone; the new ones are readable.
		expect(await store.get(first!)).toBeNull();
		expect((await store.get(second!))?.contentType).toBe("image/jpeg");
	});

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

describe("pruneReceipts", () => {
	const CUTOFF = "2026-01-01T00:00:00.000Z";

	/** Adds an expense, stores a photo for it, and returns the expense id. */
	async function withReceipt(session: FormSession, description: string, store: ReceiptStore) {
		const id = await addExpense(session, description);
		await saveReceipt(database, store, id, { bytes: new Uint8Array(8), type: "image/png" });
		const key = (
			await db()
				.prepare("SELECT object_key FROM receipts WHERE expense_id = ?")
				.bind(id)
				.first<{ object_key: string }>()
		)?.object_key;
		return { id, key: key! };
	}

	it("deletes rows older than the cutoff in one statement, keeping newer ones", async () => {
		const store = memoryReceipts();
		const session = await signUpAndLogIn("mike@example.com");

		const old = await withReceipt(session, "Old receipt", store);
		const fresh = await withReceipt(session, "Fresh receipt", store);
		// Pin both instants so the result does not depend on the machine clock.
		await db()
			.prepare("UPDATE receipts SET created_at = ? WHERE expense_id = ?")
			.bind("2020-01-01T00:00:00.000Z", old.id)
			.run();
		await db()
			.prepare("UPDATE receipts SET created_at = ? WHERE expense_id = ?")
			.bind("2026-11-20T00:00:00.000Z", fresh.id)
			.run();

		expect(await pruneReceipts(database, CUTOFF)).toBe(1);

		expect(await receiptCount(old.id)).toBe(0);
		expect(await receiptCount(fresh.id)).toBe(1);
		// Rows only: the bytes are the store's business, expired by a lifecycle
		// rule on the same window, so the object is still there.
		expect(await store.get(old.key)).not.toBeNull();
		expect(await store.get(fresh.key)).not.toBeNull();
	});
});

describe("expensesWithReceipts", () => {
	it("leaves out a receipt older than notBefore", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		const id = await addExpense(session, "Expired link");
		await saveReceipt(database, memoryReceipts(), id, { bytes: new Uint8Array(4), type: "image/png" });
		await db()
			.prepare("UPDATE receipts SET created_at = ? WHERE expense_id = ?")
			.bind("2020-01-01T00:00:00.000Z", id)
			.run();

		expect(await expensesWithReceipts(database, [id])).toEqual(new Set([id]));
		expect(await expensesWithReceipts(database, [id], "2026-01-01T00:00:00.000Z")).toEqual(new Set());
	});
});

describe("receiptCutoff", () => {
	it("returns an ISO instant a window before now", () => {
		expect(receiptCutoff(90, new Date("2026-11-27T00:00:00.000Z"))).toBe("2026-08-29T00:00:00.000Z");
	});

	it("treats a wild window as keep-forever instead of throwing", () => {
		const now = new Date("2026-11-27T00:00:00.000Z");
		const forever = receiptCutoff(MAX_RETENTION_DAYS, now);
		expect(receiptCutoff(Number.POSITIVE_INFINITY, now)).toBe(forever);
		expect(receiptCutoff(Number.NaN, now)).toBe(forever);
		expect(receiptCutoff(0, now)).toBe(forever);
	});
});

describe("a receipt retention window", () => {
	const store = memoryReceipts();
	const expiring = createCuotaApp({
		database,
		config: testConfig,
		assets: { fetch: () => new Response("asset") },
		receipts: store,
		receiptRetentionDays: 90,
	});

	it("stops linking an aged receipt and sweeps its row as the list is drawn", async () => {
		const session = await signUpAndLogIn("mike@example.com");

		const aged = await addExpense(session, "Aged link");
		await saveReceipt(database, store, aged, { bytes: new Uint8Array(8), type: "image/png" });
		await db()
			.prepare("UPDATE receipts SET created_at = ? WHERE expense_id = ?")
			.bind("2020-01-01T00:00:00.000Z", aged)
			.run();

		const fresh = await addExpense(session, "Fresh link");
		await saveReceipt(database, store, fresh, { bytes: new Uint8Array(8), type: "image/png" });

		const html = await withApp(expiring, session, "/", {}).then((r) => r.text());
		expect(html).not.toContain(`/expenses/${aged}/photo`);
		expect(html).toContain(`/expenses/${fresh}/photo`);

		// Drawing the page swept the aged row, leaving the fresh one.
		expect(await receiptCount(aged)).toBe(0);
		expect(await receiptCount(fresh)).toBe(1);
	});

	it("does not serve a photo past the window, even before the sweep", async () => {
		const session = await signUpAndLogIn("mike@example.com");

		const aged = await addExpense(session, "Aged route");
		await saveReceipt(database, store, aged, { bytes: new Uint8Array(8), type: "image/png" });
		await db()
			.prepare("UPDATE receipts SET created_at = ? WHERE expense_id = ?")
			.bind("2020-01-01T00:00:00.000Z", aged)
			.run();

		const fresh = await addExpense(session, "Fresh route");
		await saveReceipt(database, store, fresh, { bytes: new Uint8Array(8), type: "image/png" });

		// No home render in between, so the row is still there: the window alone
		// is what refuses the aged photo.
		expect((await withApp(expiring, session, `/expenses/${aged}/photo`, {})).status).toBe(404);
		expect((await withApp(expiring, session, `/expenses/${fresh}/photo`, {})).status).toBe(200);
	});
});

describe("fileReceipts", () => {
	it("round-trips an object with its content type, and deletes it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cuota-receipts-"));
		try {
			const store = fileReceipts(dir);

			await store.put("abc123", new Uint8Array([1, 2, 3]), "image/png");
			const got = await store.get("abc123");
			expect(got?.contentType).toBe("image/png");
			expect(Array.from(got?.body ?? [])).toEqual([1, 2, 3]);

			expect(await store.get("missing")).toBeNull();

			await store.delete("abc123");
			expect(await store.get("abc123")).toBeNull();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses a key that would escape the directory", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cuota-receipts-"));
		try {
			const store = fileReceipts(dir);
			await expect(store.put("../escape", new Uint8Array([1]), "image/png")).rejects.toThrow(
				"plain identifier",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
