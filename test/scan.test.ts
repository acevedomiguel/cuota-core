import { env } from "./harness.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_BYTES } from "../src/deepseek.js";
import { MAX_UPLOAD_BYTES, imageProblem, prefillNotice, prefillValues } from "../src/routes/scan.js";
import { getPage, initDb, postMultipart, signUpAndLogIn } from "./helpers.js";

beforeAll(initDb);

const TODAY = "2026-11-23";

const jpeg = () => new File([new Uint8Array([1, 2, 3])], "invoice.jpg", { type: "image/jpeg" });

function upload(file: File, csrf: string, field = "photo"): FormData {
	const form = new FormData();
	form.set("_csrf", csrf);
	form.set(field, file);
	return form;
}

/** Replaces global fetch with a DeepSeek chat-completion reply. */
function stubDeepSeek(content: string, status = 200) {
	const calls: RequestInit[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			calls.push(init ?? {});
			return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
				status,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return calls;
}

// No test may reach the real network: any unstubbed outbound call throws, which
// readInvoice turns into an "upstream" failure the route reports.
beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn(() => {
		throw new Error("unexpected outbound fetch in test");
	}));
});
afterEach(() => vi.unstubAllGlobals());

const countExpenses = async () =>
	Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM expenses").first<{ n: number }>())?.n ?? 0);

describe("imageProblem", () => {
	it("passes an acceptable image and flags bad types and oversize files", () => {
		expect(imageProblem({ type: "image/jpeg", size: 1000 })).toBeNull();
		expect(imageProblem({ type: "image/png", size: 1000 })).toBeNull();
		expect(imageProblem({ type: "application/pdf", size: 1000 })).toBe("type");
		expect(imageProblem({ type: "image/jpeg", size: MAX_IMAGE_BYTES + 1 })).toBe("size");
	});
});

describe("prefillValues", () => {
	it("turns a reading into add-form values", () => {
		expect(
			prefillValues(
				{ amountCents: 124050, currency: "HKD", date: "2026-11-20", vendor: "Fusion Deli", confidence: 0.9 },
				TODAY,
			),
		).toEqual({ amount: "1240.50", description: "Fusion Deli", date: "2026-11-20", payer: "me", category: "uncategorized" });
	});

	it("falls back to today for a missing or future date, and blanks a missing amount", () => {
		const future = prefillValues({ amountCents: 500, currency: null, date: "2999-01-01", vendor: null, confidence: null }, TODAY);
		expect(future.date).toBe(TODAY);
		expect(future.amount).toBe("5.00");
		expect(future.description).toBe("");
		const blank = prefillValues({ amountCents: null, currency: null, date: null, vendor: null, confidence: null }, TODAY);
		expect(blank.amount).toBe("");
	});

	it("caps a long vendor at the description limit", () => {
		const long = prefillValues({ amountCents: 100, currency: null, date: null, vendor: "x".repeat(200), confidence: null }, TODAY);
		expect(long.description.length).toBe(120);
	});
});

describe("prefillNotice", () => {
	it("names the amount, notes a foreign currency, and flags low confidence", () => {
		expect(prefillNotice({ amountCents: 100, currency: "HKD", date: null, vendor: null, confidence: 0.9 })).toContain(
			"Amount read from the photo.",
		);
		expect(prefillNotice({ amountCents: 100, currency: "USD", date: null, vendor: null, confidence: 0.9 })).toContain(
			"the photo shows USD",
		);
		expect(prefillNotice({ amountCents: 100, currency: "HKD", date: null, vendor: null, confidence: 0.2 })).toContain(
			"Low confidence",
		);
	});

	it("says so when no amount could be read", () => {
		expect(prefillNotice({ amountCents: null, currency: null, date: null, vendor: null, confidence: null })).toContain(
			"Couldn't find an amount",
		);
	});
});

describe("GET /scan", () => {
	it("offers a file upload form with a CSRF token", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		const html = await getPage(session, "/scan");
		expect(html).toContain('enctype="multipart/form-data"');
		expect(html).toContain('name="photo"');
		expect(html).toContain('accept="image/jpeg,image/png,image/gif,image/webp"');
		expect(html).toContain("_csrf");
	});
});

describe("POST /scan", () => {
	it("rejects a post with no photo", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		const res = await postMultipart("/scan", upload(jpeg(), session.csrf, "other"), session);
		expect(res.status).toBe(422);
		expect(await res.text()).toContain("Choose a photo");
	});

	it("rejects a file that is not an image", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		const bad = new File([new Uint8Array([1])], "notes.txt", { type: "text/plain" });
		const res = await postMultipart("/scan", upload(bad, session.csrf), session);
		expect(res.status).toBe(422);
		expect(await res.text()).toContain("PNG, GIF, or WebP");
	});

	it("refuses an oversized upload before it is read, without calling the model", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		// Larger than the multipart body cap, so the guard must reject it before
		// the CSRF middleware buffers the upload (the throwing fetch in
		// beforeEach would turn any model call into a 502 instead).
		const huge = new File([new Uint8Array(MAX_UPLOAD_BYTES)], "huge.jpg", { type: "image/jpeg" });
		const res = await postMultipart("/scan", upload(huge, session.csrf), session);
		expect(res.status).toBe(422);
		expect(await res.text()).toContain("larger than");
	});

	it("pre-fills the add form from the model's reading and saves nothing", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		const before = await countExpenses();
		stubDeepSeek('{"amount":"1,240.50","currency":"HKD","date":"2026-11-20","vendor":"Fusion Deli","confidence":0.9}');

		const res = await postMultipart("/scan", upload(jpeg(), session.csrf), session);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('value="1240.50"');
		expect(html).toContain('value="Fusion Deli"');
		expect(html).toContain("Amount read from the photo");
		expect(html).toContain("Save expense");
		expect(await countExpenses()).toBe(before);
	});

	it("still lands on the form, with a warning, when no amount is read", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		stubDeepSeek('{"amount":null,"currency":null,"date":null,"vendor":"Blurry Mart","confidence":0.3}');
		const res = await postMultipart("/scan", upload(jpeg(), session.csrf), session);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("find an amount in that photo");
		expect(html).toContain('value="Blurry Mart"');
	});

	it("reports a 502 when the model call fails", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		const res = await postMultipart("/scan", upload(jpeg(), session.csrf), session);
		expect(res.status).toBe(502);
		expect(await res.text()).toContain("add the expense by hand");
	});
});
