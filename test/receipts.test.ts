import { env, SELF } from "./harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import { MAX_RECEIPT_BYTES, receiptProblem } from "../src/receipts.js";
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

/** A tiny stand-in for a captured photo. */
function photoFile(type = "image/png", name = "receipt.png"): File {
	return new File([new Uint8Array(64).fill(7)], name, { type });
}

/** Posts the add form as multipart, with an optional photo. */
async function addExpense(
	session: FormSession,
	description: string,
	photo?: File,
): Promise<Response> {
	const form = new FormData();
	form.set("_csrf", session.csrf);
	form.set("amount", "12.50");
	form.set("description", description);
	form.set("payer", "me");
	form.set("date", "2026-01-01");
	form.set("category", "uncategorized");
	if (photo) form.set("photo", photo);
	return await postMultipart("/add", form, session);
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
