import { describe, expect, it, vi } from "vitest";
import {
	buildInvoiceRequest,
	DEFAULT_MODEL,
	ENDPOINT,
	readCompletionContent,
	readInvoice,
	toBase64,
} from "../src/deepseek.js";

const IMAGE = { bytes: new Uint8Array([1, 2, 3, 4]), mimeType: "image/jpeg" };

function jsonResponse(content: string, status = 200): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("toBase64", () => {
	it("round-trips bytes through base64", () => {
		const bytes = new Uint8Array([0, 255, 65, 66, 67]);
		expect(toBase64(bytes)).toBe(btoa(String.fromCharCode(...bytes)));
	});
});

describe("buildInvoiceRequest", () => {
	it("inlines the image as a base64 data URL for the chat endpoint", () => {
		const request = buildInvoiceRequest(IMAGE, DEFAULT_MODEL) as {
			model: string;
			temperature: number;
			messages: { role: string; content: unknown }[];
		};
		expect(request.model).toBe(DEFAULT_MODEL);
		expect(request.temperature).toBe(0);
		expect(request.messages[0].role).toBe("system");
		const content = request.messages[1].content as { type: string; image_url?: { url: string } }[];
		expect(content[0].type).toBe("text");
		expect(content[1].image_url?.url).toBe(`data:image/jpeg;base64,${toBase64(IMAGE.bytes)}`);
	});
});

describe("readCompletionContent", () => {
	it("pulls the assistant text, and null otherwise", () => {
		expect(readCompletionContent({ choices: [{ message: { content: "hi" } }] })).toBe("hi");
		expect(readCompletionContent({ choices: [] })).toBeNull();
		expect(readCompletionContent({ choices: [{ message: { content: 5 } }] })).toBeNull();
		expect(readCompletionContent(null)).toBeNull();
	});
});

describe("readInvoice", () => {
	it("reports not-configured without calling the API when the key is missing", async () => {
		const fetchImpl = vi.fn();
		const result = await readInvoice(null, IMAGE, fetchImpl);
		expect(result).toEqual({ ok: false, reason: "not-configured" });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("posts the image and returns the parsed reading", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse('{"amount":"1,240.50","currency":"HKD","vendor":"Deli"}'));
		const result = await readInvoice({ apiKey: "k" }, IMAGE, fetchImpl);
		expect(result).toEqual({
			ok: true,
			reading: { amountCents: 124050, currency: "HKD", date: null, vendor: "Deli", confidence: null },
		});
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(ENDPOINT);
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
	});

	it("treats a non-2xx reply and a thrown transport as upstream failures", async () => {
		const failing = vi.fn(async () => jsonResponse("nope", 500));
		expect(await readInvoice({ apiKey: "k" }, IMAGE, failing)).toEqual({ ok: false, reason: "upstream" });
		const throwing = vi.fn(async () => {
			throw new Error("network down");
		});
		expect(await readInvoice({ apiKey: "k" }, IMAGE, throwing)).toEqual({ ok: false, reason: "upstream" });
	});

	it("reports unreadable when the reply holds no JSON object", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse("I cannot read this image."));
		expect(await readInvoice({ apiKey: "k" }, IMAGE, fetchImpl)).toEqual({ ok: false, reason: "unreadable" });
	});
});
