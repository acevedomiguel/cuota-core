// Transport for reading an invoice photo with DeepSeek's multimodal model.
// Shaping the reply lives in invoice.ts; this module only talks to the API and
// takes an injectable fetch, so the request can be pinned without a network.

import { parseInvoiceResponse, type InvoiceReading } from "./invoice.js";
import type { InvoiceReaderConfig } from "./config.js";

/** The current multimodal model; overridable via the DEEPSEEK_MODEL var. */
export const DEFAULT_MODEL = "deepseek-flash";
export const ENDPOINT = "https://api.deepseek.com/chat/completions";

/** The image types DeepSeek accepts (invoice photos are almost always JPEG). */
export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

/** Refuse anything larger, so a stray RAW/TIFF can't be read into memory. */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const SYSTEM_PROMPT =
	"You read a single receipt or invoice photograph and reply with JSON only. " +
	"Never guess a value you cannot see: use null instead.";

const USER_PROMPT = [
	"Read the amount the customer must pay from this photo and reply with one JSON object:",
	'{"amount": "<plain decimal, the final total or amount due>", "currency": "<ISO 4217 code, e.g. HKD>",',
	' "date": "<YYYY-MM-DD>", "vendor": "<merchant name or a short description>", "confidence": "<0 to 1>"}',
	"Use the final total or the amount due — not a subtotal, a tax line, or a single line item.",
	"Reply with the JSON only: no prose and no code fences.",
].join("\n");

export interface ImageInput {
	bytes: Uint8Array;
	mimeType: string;
}

export type ReadResult =
	| { ok: true; reading: InvoiceReading }
	| { ok: false; reason: "not-configured" | "upstream" | "unreadable" };

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Base64 for a binary body, chunked so a large photo cannot blow the stack. */
export function toBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/** The OpenAI-compatible chat request DeepSeek expects, image inlined. */
export function buildInvoiceRequest(image: ImageInput, model: string): Record<string, unknown> {
	return {
		model,
		temperature: 0,
		max_tokens: 700,
		messages: [
			{ role: "system", content: SYSTEM_PROMPT },
			{
				role: "user",
				content: [
					{ type: "text", text: USER_PROMPT },
					{
						type: "image_url",
						image_url: { url: `data:${image.mimeType};base64,${toBase64(image.bytes)}` },
					},
				],
			},
		],
	};
}

/** Pulls the assistant text out of an OpenAI-compatible chat completion. */
export function readCompletionContent(payload: unknown): string | null {
	const content = (payload as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]
		?.message?.content;
	return typeof content === "string" ? content : null;
}

/**
 * Reads one invoice photo. Never throws for an expected failure: a missing key,
 * a network or API error, and a reply with nothing readable each come back as a
 * distinct `reason` for the route to explain.
 */
export async function readInvoice(
	config: InvoiceReaderConfig | null,
	image: ImageInput,
	fetchImpl?: FetchLike,
): Promise<ReadResult> {
	const apiKey = config?.apiKey;
	if (!apiKey) return { ok: false, reason: "not-configured" };

	// Resolve the global at call time (not capture it) so a test can stub it.
	const doFetch: FetchLike = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

	let response: Response;
	try {
		response = await doFetch(ENDPOINT, {
			method: "POST",
			headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
			body: JSON.stringify(buildInvoiceRequest(image, config.model ?? DEFAULT_MODEL)),
			signal: AbortSignal.timeout(25_000),
		});
	} catch {
		return { ok: false, reason: "upstream" };
	}
	if (!response.ok) return { ok: false, reason: "upstream" };

	const content = readCompletionContent(await response.json().catch(() => null));
	if (content === null) return { ok: false, reason: "upstream" };

	const reading = parseInvoiceResponse(content);
	if (!reading) return { ok: false, reason: "unreadable" };
	return { ok: true, reading };
}
