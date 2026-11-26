import { SELF } from "./harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import { initDb } from "./helpers.js";

/**
 * The stylesheet is asserted through the exact bytes the browser receives from
 * the static asset route (as in test/dark-mode.test.ts). Importing
 * `public/styles.css?raw` resolves to an empty module under the Cloudflare
 * vitest plugin, which would make every assertion below vacuous.
 */
let styles = "";

beforeAll(async () => {
	await initDb();
	const res = await SELF.fetch("http://example.com/static/styles.css");
	expect(res.status).toBe(200);
	styles = await res.text();
});

/** The declaration body of the first rule whose selector matches exactly. */
function ruleBody(selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return styles.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

/** The body of an `@media <query>` block, matched with balanced braces. */
function mediaBlock(query: string): string {
	const start = styles.indexOf(`@media ${query}`);
	if (start === -1) return "";
	const open = styles.indexOf("{", start);
	let depth = 0;
	for (let i = open; i < styles.length; i += 1) {
		if (styles[i] === "{") depth += 1;
		else if (styles[i] === "}") {
			depth -= 1;
			if (depth === 0) return styles.slice(open + 1, i);
		}
	}
	return "";
}

describe("responsive layout contracts", () => {
	it("loads a non-vacuous stylesheet and keeps the theme sizing tokens", () => {
		expect(styles.length).toBeGreaterThan(5000);
		expect(styles).toMatch(/--target-size:\s*24px/);
		expect(styles).toMatch(/@media \(pointer: coarse\)/);
		expect(styles).toMatch(/--target-size:\s*44px/);
	});

	it("bounds the visually hidden payer radios to 1px", () => {
		const body = ruleBody(".payer input");
		expect(body).not.toBe("");
		// Still an invisible, absolutely positioned control — not display:none.
		expect(body).toMatch(/position:\s*absolute/);
		expect(body).toMatch(/opacity:\s*0/);
		expect(body).not.toMatch(/display:\s*none/);
		// No longer inherits the full-width text-input sizing from `.field input`.
		expect(body).toMatch(/inline-size:\s*1px/);
		expect(body).toMatch(/block-size:\s*1px/);
		expect(body).toMatch(/min-inline-size:\s*0/);
		expect(body).toMatch(/min-block-size:\s*0/);
		expect(body).toMatch(/padding:\s*0/);
		expect(body).toMatch(/margin:\s*0/);
	});

	it("shows a visible focus ring on the payer label", () => {
		const body = ruleBody(".payer label:has(input:focus-visible)");
		expect(body).not.toBe("");
		expect(body).toMatch(/outline:\s*2px solid var\(--accent\)/);
		expect(body).toMatch(/outline-offset:\s*2px/);
	});

	it("scales both wordmarks by exactly 1.25", () => {
		expect(ruleBody(".wordmark")).toMatch(
			/font-size:\s*clamp\(2\.25rem,\s*1\.8rem \+ 2\.25vw,\s*2\.625rem\)/,
		);
		expect(ruleBody(".login .brand .wordmark")).toMatch(
			/font-size:\s*clamp\(3\.75rem,\s*3rem \+ 3\.75vw,\s*4\.5rem\)/,
		);
		// The sidebar brand is an <a>: `.sidebar a` menu sizing would override
		// the base `.wordmark` size without this more specific rule.
		expect(ruleBody(".sidebar .wordmark")).toMatch(
			/font-size:\s*clamp\(2\.25rem,\s*1\.8rem \+ 2\.25vw,\s*2\.625rem\)/,
		);
	});

	it("compacts the narrow-screen pill without hiding anything", () => {
		const narrow = mediaBlock("(max-width: 35rem)");
		expect(narrow).not.toBe("");
		expect(narrow).not.toMatch(/display:\s*none/);
		expect(narrow).not.toMatch(/overflow(-x)?:\s*(hidden|clip)/);
		expect(narrow).not.toMatch(/flex-wrap|column-reverse/);
		expect(narrow).toMatch(/\.bottombar\s*\{[^}]*padding-inline:\s*0\.25rem/);
		expect(narrow).toMatch(/\.bottombar \.pill\s*\{[^}]*gap:\s*0\.125rem/);
		expect(narrow).toMatch(/\.bottombar \.pill\s*\{[^}]*padding:\s*0\.25rem/);
		expect(narrow).toMatch(/\.bottombar \.pill\s*\{[^}]*max-inline-size:\s*100%/);
		expect(narrow).toMatch(/\.bottombar a\s*\{[^}]*padding:\s*0\.625rem 0\.5rem/);
		expect(narrow).toMatch(/\.bottombar a\s*\{[^}]*font-size:\s*0\.8125rem/);
		expect(narrow).toMatch(/white-space:\s*nowrap/);
	});

	it("switches the pill to a two-row grid on the narrowest phones", () => {
		// Seven destinations cannot share one row at 320px without clipping or
		// hiding something, so the pill becomes a four-column grid instead.
		const narrowest = mediaBlock("(max-width: 23rem)");
		expect(narrowest).not.toBe("");
		expect(narrowest).toMatch(/\.bottombar \.pill\s*\{[^}]*display:\s*grid/);
		expect(narrowest).toMatch(/grid-template-columns:\s*repeat\(4,/);
		expect(narrowest).not.toMatch(/display:\s*none/);
		expect(narrowest).not.toMatch(/overflow(-x)?:\s*(hidden|clip)/);
	});

	it("keeps the fab and the coarse-pointer target size intact", () => {
		const narrow = mediaBlock("(max-width: 35rem)");
		expect(narrow).not.toMatch(/\.fab/);
		// Base fab dimensions are untouched by the narrow override.
		expect(ruleBody(".bottombar .fab")).toMatch(/inline-size:\s*3\.25rem/);
		expect(ruleBody(".bottombar .fab")).toMatch(/block-size:\s*3\.25rem/);
	});

	it("anchors the theme toggle to the bottom without CSS reordering", () => {
		// The brand now sits naturally at the top; the toggle carries the auto
		// top margin that pushes it to the bottom of the rail.
		expect(ruleBody(".sidebar .brand")).not.toMatch(/margin-block-start:\s*auto/);
		expect(ruleBody(".theme-toggle")).toMatch(/margin-block-start:\s*auto/);
		expect(styles).not.toMatch(/column-reverse/);
		// No `order` property on the interactive nav rules.
		expect(ruleBody(".sidebar .brand")).not.toMatch(/(^|;)\s*order:/);
		expect(ruleBody(".sidebar ul")).not.toMatch(/(^|;)\s*order:/);
		expect(ruleBody(".theme-toggle")).not.toMatch(/(^|;)\s*order:/);
	});

	it("renders the theme toggle as a round, icon-sized control", () => {
		const body = ruleBody(".theme-toggle");
		expect(body).not.toBe("");
		expect(body).toMatch(/border-radius:\s*50%/);
		// Equal width and height, at least the 44px coarse-pointer target.
		expect(body).toMatch(/inline-size:\s*2\.75rem/);
		expect(body).toMatch(/block-size:\s*2\.75rem/);
	});
});
