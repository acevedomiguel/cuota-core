import { env, SELF } from "./harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import { initDb } from "./helpers.js";

/**
 * NOTE: the plan prescribed `import styles from "../public/styles.css?raw"`.
 * Under the previous test harness that import resolves to an empty string,
 * because `public/` is a static-asset directory that the plugin does not feed
 * through Vite's `?raw` loader (an empty module makes every assertion vacuous).
 * We instead assert against the exact bytes the browser receives from the
 * static asset route, which is the same file and a stronger contract.
 */
let styles = "";

beforeAll(async () => {
	await initDb();
	const res = await SELF.fetch("http://example.com/static/styles.css");
	expect(res.status).toBe(200);
	styles = await res.text();
});

/** The base `:root` block: light tokens plus the raw `--dark-*` values. */
function baseRoot(): string {
	return styles.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
}

/**
 * Raw dark values. They are declared exactly once, in the base block, and the
 * automatic and explicit dark states alias them — so both palettes provably
 * cannot drift apart. These helpers resolve the aliases back to real values,
 * which keeps every assertion below about the *effective* palette.
 */
const RAW_DARK = /(--dark-[\w-]+):\s*([^;]+);/g;

function rawDark(): Record<string, string> {
	return Object.fromEntries([...styles.matchAll(RAW_DARK)].map((m) => [m[1], m[2].trim()]));
}

/** Substitutes `var(--dark-*)` aliases with their raw values. */
function resolved(block: string): string {
	const raw = rawDark();
	return block.replace(/var\((--dark-[\w-]+)\)/g, (whole, name: string) => raw[name] ?? whole);
}

/**
 * The automatic (System) dark block: the media query scoped to the untouched
 * `light dark` meta, so an explicit override is never undone by the OS.
 */
function autoDarkBlock(): string {
	return (
		styles.match(
			/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:has\(> head > meta\[name="color-scheme"\]\[content="light dark"\]\)\s*\{([\s\S]*?)\n\s*\}\s*\}/,
		)?.[1] ?? ""
	);
}

/** The explicit dark override block. */
function manualDarkBlock(): string {
	return styles.match(/:root:has\(> head > meta\[name="color-scheme"\]\[content="dark"\]\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
}

/** The effective dark token declarations, aliases resolved. */
function darkRoot(): string {
	return resolved(autoDarkBlock());
}

describe("dark mode contract", () => {
	it("serves the real stylesheet, not an empty stand-in", () => {
		expect(styles).toContain("--accent");
		expect(styles.length).toBeGreaterThan(1000);
	});

	it("declares browser and document color-scheme support", async () => {
		expect(baseRoot()).toContain("color-scheme: light dark");
		const res = await SELF.fetch("http://example.com/login");
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('<meta name="color-scheme" content="light dark">');
	});

	it("defines the dark semantic palette", () => {
		const dark = darkRoot();
		expect(dark).not.toBe("");
		for (const declaration of [
			"--bg: #000000",
			"--card: #1c1c1e",
			"--ink: #f5f5f7",
			"--ink-2: #a1a1a6",
			"--ink-3: #86868b",
			"--accent: #9b98ff",
			"--accent-ink: #1d1d1f",
			"--llama: #ff7d92",
			"--mono: #50c5d8",
		]) expect(dark).toContain(declaration);
	});

	it("keeps the automatic and explicit dark palettes identical", () => {
		// The explicit override must select every dark token, not a subset.
		const tokens = (block: string): Record<string, string> =>
			Object.fromEntries(
				[...resolved(block).matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
			);
		const automatic = tokens(autoDarkBlock());
		expect(Object.keys(automatic).length).toBeGreaterThan(15);
		expect(tokens(manualDarkBlock())).toEqual(automatic);
	});

	it("themes translucent surfaces and fixed-color effects through tokens", () => {
		for (const token of ["--pill-bg", "--border-subtle", "--border-sidebar", "--border-strong", "--state-selected", "--state-hover", "--tint-base", "--tint-ink", "--accent-glow"]) {
			expect(styles).toContain(`var(${token})`);
		}
		expect(styles).not.toContain("rgb(255 255 255 / 0.85)");
		expect(styles).not.toContain("rgb(94 92 230 / 0.14)");
	});
});

/**
 * PR #3 review fixes. The review found that light-mode muted hints and
 * Llama/Mono text sat below 4.5:1, and that the dark-mode work had changed the
 * light expense hover from 3% to 4%. These tokens fix the text without
 * touching the brand bars, dots, or selected-tint backgrounds.
 */
describe("dark mode review fixes", () => {
	it("raises the light muted hint to an accessible grey", () => {
		expect(baseRoot()).toContain("--ink-3: #6e6e73");
		expect(baseRoot()).not.toContain("--ink-3: #aeaeb2");
	});

	it("adds accessible light and dark text-specific brand tokens", () => {
		for (const declaration of ["--llama-ink: #bd2850", "--mono-ink: #0b6f7a", "--state-hover-subtle: rgb(0 0 0 / 0.03)"]) {
			expect(baseRoot()).toContain(declaration);
		}
		for (const declaration of ["--llama-ink: #ff7d92", "--mono-ink: #50c5d8", "--state-hover-subtle: rgb(255 255 255 / 0.10)"]) {
			expect(darkRoot()).toContain(declaration);
		}
	});

	it("leaves the brand bars, dots and selected tints on the original hues", () => {
		expect(baseRoot()).toContain("--llama: #ff6482");
		expect(baseRoot()).toContain("--mono: #30b0c7");
		expect(baseRoot()).toContain("--state-hover: rgb(0 0 0 / 0.04)");
		expect(darkRoot()).toContain("--llama: #ff7d92");
		expect(darkRoot()).toContain("--mono: #50c5d8");
	});

	it("routes brand text through the text tokens and the tint through the original hue", () => {
		expect(styles).toContain(".balance .who.llama { color: var(--llama-ink); }");
		expect(styles).toContain(".balance .who.mono { color: var(--mono-ink); }");
		expect(styles).toContain(".preview .side .name.llama { color: var(--llama-ink); }");
		expect(styles).toContain(".preview .side .name.mono { color: var(--mono-ink); }");
		expect(styles).toMatch(/\.payer label:has\(input:checked\)\.llama \{[^}]*background: color-mix\(in srgb, var\(--llama\) 15%, var\(--tint-base\)\);[^}]*color: var\(--llama-ink\);[^}]*\}/);
		expect(styles).toMatch(/\.payer label:has\(input:checked\)\.mono \{[^}]*background: color-mix\(in srgb, var\(--mono\) 15%, var\(--tint-base\)\);[^}]*color: var\(--mono-ink\);[^}]*\}/);
	});

	it("restores the 3% light expense hover without touching other hovers", () => {
		expect(styles).toContain(".expenses li:hover { background: var(--state-hover-subtle); }");
		expect(styles).toContain(".sidebar a:hover { background: var(--state-hover); color: var(--ink); }");
		expect(styles).toContain(".sidebar .brand:hover { background: var(--state-hover); }");
	});
});
