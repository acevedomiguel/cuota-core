import { describe, expect, it } from "vitest";
import { csvField, formulaSafe, plainAmount, toCsv } from "../src/csv.js";

describe("csvField", () => {
	it("leaves a plain value alone", () => {
		expect(csvField("Groceries")).toBe("Groceries");
	});

	it("quotes a value containing a comma, a quote, or a line break", () => {
		expect(csvField("Dinner, drinks")).toBe('"Dinner, drinks"');
		expect(csvField('He said "hi"')).toBe('"He said ""hi"""');
		expect(csvField("line\nbreak")).toBe('"line\nbreak"');
		// A lone quote and an already-doubled one both stay inside the field.
		expect(csvField('"')).toBe('""""');
		expect(csvField('""')).toBe('""""""');
		expect(csvField("carriage\rreturn")).toBe('"carriage\rreturn"');
	});
});

describe("formulaSafe", () => {
	it("prefixes a value a spreadsheet would evaluate", () => {
		expect(formulaSafe("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
		expect(formulaSafe("+1")).toBe("'+1");
		expect(formulaSafe("-1")).toBe("'-1");
		expect(formulaSafe("@cmd")).toBe("'@cmd");
		// A spreadsheet trims these before deciding, so they are guarded too.
		expect(formulaSafe("\t=1+1")).toBe("'\t=1+1");
		expect(formulaSafe("\r=1+1")).toBe("'\r=1+1");
	});

	it("leaves an ordinary value alone", () => {
		expect(formulaSafe("Groceries")).toBe("Groceries");
		expect(formulaSafe("")).toBe("");
		// A value that is already just a quote is not a formula.
		expect(formulaSafe("'")).toBe("'");
	});
});

describe("plainAmount", () => {
	it("formats integer cents as a decimal a spreadsheet can add up", () => {
		expect(plainAmount(1250)).toBe("12.50");
		expect(plainAmount(5)).toBe("0.05");
		expect(plainAmount(0)).toBe("0.00");
		expect(plainAmount(-1250)).toBe("-12.50");
	});
});

describe("toCsv", () => {
	it("writes a BOM, CRLF rows, and escapes only what needs it", () => {
		const csv = toCsv([
			["date", "description"],
			["2026-01-02", "Dinner, drinks"],
		]);
		expect(csv).toBe('\uFEFFdate,description\r\n2026-01-02,"Dinner, drinks"\r\n');
	});

	it("writes a header-only document for no rows", () => {
		expect(toCsv([["a", "b"]])).toBe("\uFEFFa,b\r\n");
	});
});
