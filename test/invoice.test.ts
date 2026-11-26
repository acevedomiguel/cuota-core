import { describe, expect, it } from "vitest";
import { normalizeAmountText, parseInvoiceResponse } from "../src/invoice.js";

describe("normalizeAmountText", () => {
	it("drops currency symbols, spaces and thousands separators", () => {
		expect(normalizeAmountText("HK$ 1,240.50")).toBe("1240.50");
		expect(normalizeAmountText("$12")).toBe("12");
		expect(normalizeAmountText("1,240")).toBe("1240");
		expect(normalizeAmountText("  9.90 ")).toBe("9.90");
	});

	it("returns null when there are no digits to keep", () => {
		expect(normalizeAmountText("")).toBeNull();
		expect(normalizeAmountText("not a number")).toBeNull();
	});
});

describe("parseInvoiceResponse", () => {
	it("reads a clean JSON reply into a reading", () => {
		const reading = parseInvoiceResponse(
			'{"amount":"1,240.50","currency":"HKD","date":"2026-11-20","vendor":"Fusion Deli","confidence":0.9}',
		);
		expect(reading).toEqual({
			amountCents: 124050,
			currency: "HKD",
			date: "2026-11-20",
			vendor: "Fusion Deli",
			confidence: 0.9,
		});
	});

	it("tolerates code fences and surrounding prose", () => {
		const fenced = parseInvoiceResponse('```json\n{"amount":"88"}\n```');
		expect(fenced?.amountCents).toBe(8800);
		const prose = parseInvoiceResponse('Here is the invoice: {"amount":"5.00"} — hope that helps!');
		expect(prose?.amountCents).toBe(500);
	});

	it("accepts a numeric amount and the total/amount_due aliases", () => {
		expect(parseInvoiceResponse('{"amount":12.5}')?.amountCents).toBe(1250);
		expect(parseInvoiceResponse('{"total":"30"}')?.amountCents).toBe(3000);
		expect(parseInvoiceResponse('{"amount_due":"7.25"}')?.amountCents).toBe(725);
	});

	it("leaves fields null rather than guessing", () => {
		const reading = parseInvoiceResponse('{"amount":null,"currency":"dollars","date":"20-11-2026","confidence":2}');
		expect(reading).toEqual({ amountCents: null, currency: null, date: null, vendor: null, confidence: null });
	});

	it("upper-cases a valid currency and trims a vendor, with a description fallback", () => {
		expect(parseInvoiceResponse('{"currency":"hkd"}')?.currency).toBe("HKD");
		expect(parseInvoiceResponse('{"vendor":"  Cafe  "}')?.vendor).toBe("Cafe");
		expect(parseInvoiceResponse('{"description":"Lunch"}')?.vendor).toBe("Lunch");
	});

	it("returns null when there is no JSON object at all", () => {
		expect(parseInvoiceResponse("I could not read this image.")).toBeNull();
		expect(parseInvoiceResponse("[1,2,3]")).toBeNull();
		expect(parseInvoiceResponse("")).toBeNull();
	});

	it("refuses a negative amount instead of silently flipping its sign", () => {
		expect(parseInvoiceResponse('{"amount":"-12.50"}')?.amountCents).toBeNull();
		expect(parseInvoiceResponse('{"amount":-12.5}')?.amountCents).toBeNull();
		expect(parseInvoiceResponse('{"total":"−1,240.50"}')?.amountCents).toBeNull();
	});

	it("keeps an absent confidence unknown rather than reading it as zero", () => {
		expect(parseInvoiceResponse('{"amount":"5","confidence":null}')?.confidence).toBeNull();
		expect(parseInvoiceResponse('{"amount":"5","confidence":""}')?.confidence).toBeNull();
		expect(parseInvoiceResponse('{"amount":"5"}')?.confidence).toBeNull();
	});
});
