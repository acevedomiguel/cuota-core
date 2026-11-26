import { SELF } from "./harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import { getPage, initDb, signUpAndLogIn } from "./helpers.js";
import type { FormSession } from "./helpers.js";

/**
 * Theme override contract (Ticket: 2026-11-23-theme-override, Task 1).
 *
 * The override is carried by the `color-scheme` meta tag, which has three
 * states: the untouched no-JS default `light dark` (System), and the explicit
 * `light` / `dark` states written before first paint by the inline bootstrap.
 * CSS keys off the meta with `:root:has(> head > meta[name="color-scheme"][content="..."])`,
 * so an explicit override wins over the OS preference while System keeps the
 * existing `prefers-color-scheme` media query.
 *
 * As in test/dark-mode.test.ts, `public/styles.css?raw` resolves to an empty
 * string under the previous test harness, so the stylesheet is read from the
 * bytes the browser actually receives.
 */
let styles = "";
let loginHtml = "";
let session: FormSession;

beforeAll(async () => {
	await initDb();
	const css = await SELF.fetch("http://example.com/static/styles.css");
	expect(css.status).toBe(200);
	styles = await css.text();
	const page = await SELF.fetch("http://example.com/login");
	expect(page.status).toBe(200);
	loginHtml = await page.text();
	session = await signUpAndLogIn("mike@example.com");
});

/** The `:root` block of the base (light) scheme. */
function baseTokens(): string {
	return styles.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
}

/**
 * Declarations of the dark token block that the *automatic* (System) state
 * uses: the media query scoped to the untouched meta value.
 */
function autoDarkTokens(): string {
	const block = styles.match(
		/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:has\(> head > meta\[name="color-scheme"\]\[content="light dark"\]\)\s*\{([\s\S]*?)\n\s*\}\s*\}/,
	)?.[1];
	if (!block) throw new Error("no meta-scoped automatic dark block found");
	return block;
}

/** Declarations of the dark token block the explicit `dark` override uses. */
function manualDarkTokens(): string {
	const block = styles.match(
		/:root:has\(> head > meta\[name="color-scheme"\]\[content="dark"\]\)\s*\{([\s\S]*?)\n\}/,
	)?.[1];
	if (!block) throw new Error("no manual dark override block found");
	return block;
}

/** True when every `--token: value` in `expected` is assigned in `block`. */
function assigns(block: string, expected: Record<string, string>): string[] {
	const missing: string[] = [];
	for (const [token, value] of Object.entries(expected)) {
		if (!block.includes(`${token}: ${value}`)) missing.push(`${token}: ${value}`);
	}
	return missing;
}

/** The full dark semantic palette; both dark states must assign all of it. */
function darkPalette(): Record<string, string> {
	const dark = autoDarkTokens();
	const tokens = [...dark.matchAll(/(--[\w-]+):\s*([^;]+);/g)];
	expect(tokens.length).toBeGreaterThan(15);
	return Object.fromEntries(tokens.map((m) => [m[1], m[2].trim()]));
}

describe("theme override: first-paint bootstrap", () => {
	it("runs a classic inline script immediately after the color-scheme meta", () => {
		const head = loginHtml.split("</head>")[0] ?? "";
		const meta = '<meta name="color-scheme" content="light dark">';
		const metaAt = head.indexOf(meta);
		expect(metaAt).toBeGreaterThan(-1);

		const rest = head.slice(metaAt + meta.length);
		const nextScript = rest.match(/<script([^>]*)>([\s\S]*?)<\/script>/);
		expect(nextScript, "no script follows the color-scheme meta").not.toBeNull();
		const [, attrs = "", body = ""] = nextScript ?? [];
		// Classic script, inline: it must not be deferred or a module, otherwise
		// the browser could paint the wrong theme before it runs.
		expect(attrs).not.toContain("src=");
		expect(attrs).not.toContain("module");
		expect(attrs).not.toContain("defer");
		expect(attrs).not.toContain("async");

		// Only two things may appear between the meta and the script: whitespace.
		expect(rest.slice(0, nextScript?.index ?? 0).trim()).toBe("");

		// It must run before the stylesheet is requested.
		expect(head.indexOf("/static/styles.css")).toBeGreaterThan(metaAt);
		expect(nextScript?.index ?? Infinity).toBeLessThan(head.indexOf("/static/styles.css") - metaAt);

		expect(body).toContain("cuota-color-scheme");
		expect(body).toContain("localStorage");
		expect(body).toContain("try");
		expect(body).toContain("catch");
		// The bootstrap may only touch the meta; no control setup, no matchMedia.
		expect(body).not.toContain("matchMedia");
	});

	it("keeps the no-JS default meta intact", () => {
		expect(loginHtml).toContain('<meta name="color-scheme" content="light dark">');
	});

	it("serves the real stylesheet, not an empty stand-in", () => {
		expect(styles.length).toBeGreaterThan(1000);
		expect(styles).toContain("--accent");
	});
});

describe("theme override: CSS states", () => {
	it("keeps root color-scheme on the automatic default", () => {
		expect(baseTokens()).toContain("color-scheme: light dark");
	});

	it("maps the meta to root color-scheme for both explicit choices", () => {
		const light = styles.match(/:root:has\(> head > meta\[name="color-scheme"\]\[content="light"\]\)\s*\{([\s\S]*?)\n\}/)?.[1];
		expect(light, "no manual light block found").toBeDefined();
		expect(light).toContain("color-scheme: light");

		const dark = manualDarkTokens();
		expect(dark).toContain("color-scheme: dark");
	});

	it("scopes the automatic dark tokens to the untouched meta only", () => {
		const media = styles.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{/);
		expect(media).not.toBeNull();
		// The automatic block must be qualified by meta content="light dark", so
		// an explicit override is never undone by the OS preference.
		expect(styles).toMatch(
			/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:has\(> head > meta\[name="color-scheme"\]\[content="light dark"\]\)/,
		);
		// No unqualified `:root` dark block may remain inside that media query.
		expect(styles).not.toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{/);
	});

	it("gives the explicit dark override the same palette as the automatic one", () => {
		const palette = darkPalette();
		expect(assigns(manualDarkTokens(), palette)).toEqual([]);
	});

	it("keeps an explicit light override on the complete light palette", () => {
		const light = styles.match(/:root:has\(> head > meta\[name="color-scheme"\]\[content="light"\]\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
		// The light state must not redefine semantic tokens: it inherits the base
		// light palette, so no dark value can leak in.
		for (const token of ["--bg", "--card", "--ink", "--ink-2", "--accent", "--tint-base"]) {
			expect(light).not.toContain(`${token}:`);
		}
	});

	it("keeps both dark states free of raw color literals", () => {
		// Two lists of literal dark colors would drift apart; the raw values live
		// once in the base block and both dark states alias them.
		for (const block of [autoDarkTokens(), manualDarkTokens()]) {
			expect(block).not.toMatch(/#[0-9a-f]{3,8}\b/i);
			expect(block).not.toContain("rgb(");
		}
	});
});

describe("theme override: settings control", () => {
	let html = "";

	beforeAll(async () => {
		html = await getPage(session, "/settings");
	});

	it("offers a labelled Appearance fieldset with all three choices", () => {
		expect(html).toContain('class="card settings-card" aria-labelledby="appearance-title"');
		expect(html).toContain('data-theme-control');
		expect(html).toMatch(/<fieldset[^>]*class="appearance"/);
		expect(html).toMatch(/<legend[^>]*>Appearance<\/legend>/);
		for (const value of ["system", "light", "dark"]) {
			expect(html).toContain(`name="color-scheme" value="${value}"`);
		}
		// System is the server-rendered default.
		expect(html).toMatch(/name="color-scheme" value="system"[^>]*checked/);
		expect(html).not.toMatch(/name="color-scheme" value="(light|dark)"[^>]*checked/);
	});

	it("labels every radio with a visible, wrapped caption", () => {
		for (const [value, label] of [["system", "System"], ["light", "Light"], ["dark", "Dark"]]) {
			expect(html).toMatch(
				new RegExp(`<label[^>]*>[\\s\\S]*?<input[^>]*name="color-scheme" value="${value}"[\\s\\S]*?${label}[\\s\\S]*?</label>`),
			);
		}
	});

	it("explains that the choice is per browser and names the current device theme", () => {
		expect(html).toContain("Follow this device, or choose a theme for Cuota on this browser.");
		expect(html).toMatch(/data-system-theme[^>]*>System \(currently (light|dark)\)</);
	});

	it("places Appearance between Passkeys and Change password", () => {
		const passkeys = html.indexOf("Passkeys");
		const appearance = html.indexOf("Appearance");
		const password = html.indexOf("Change password");
		expect(passkeys).toBeGreaterThan(-1);
		expect(appearance).toBeGreaterThan(passkeys);
		expect(password).toBeGreaterThan(appearance);
	});

	it("keeps a single visible heading that also names the card", () => {
		expect(html).toMatch(/<legend id="appearance-title">Appearance<\/legend>/);
		// Exactly one element names the card: no duplicate heading for screen readers.
		expect(html.match(/id="appearance-title"/g)?.length).toBe(1);
	});

	it("stays understandable without JavaScript", () => {
		// The static markup still explains System rather than relying on the
		// script to rewrite the hint.
		expect(html).toContain("System (currently light)");
	});

	it("loads the toggle script exactly once on every authenticated page with the sidebar", async () => {
		for (const path of ["/", "/add", "/incomes", "/opening-balance", "/settings", "/about"]) {
			const page = await getPage(session, path);
			expect(page.match(/\/static\/theme\.js/g)?.length, path).toBe(1);
		}
	});

	it("keeps the toggle script off public pages", async () => {
		const signup = await SELF.fetch("http://example.com/signup");
		expect(signup.status).toBe(200);
		expect(await signup.text()).not.toContain("/static/theme.js");
		expect(loginHtml).not.toContain("/static/theme.js");

		// The Error view is rendered for the CSRF-rejection path; it must stay
		// script-free too.
		const error = await SELF.fetch("http://example.com/login", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ email: "a@example.com", password: "x" }),
			redirect: "manual",
		});
		expect(error.status).toBe(403);
		expect(await error.text()).not.toContain("/static/theme.js");
	});

	it("serves theme.js as a classic script with the required behavior", async () => {
		const res = await SELF.fetch("http://example.com/static/theme.js");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/javascript/);
		const script = await res.text();
		expect(script.length).toBeGreaterThan(0);
		expect(script).toContain("cuota-color-scheme");
		expect(script).toContain("removeItem");
		expect(script).toContain("setItem");
		expect(script).toContain('"storage"');
		expect(script).toContain("matchMedia");
		expect(script).toContain("prefers-color-scheme: dark");
		// Classic script: no module syntax, no dependencies, no network calls.
		expect(script).not.toMatch(/^\s*(import|export)\s/m);
		expect(script).not.toContain("fetch(");
		expect(script).not.toContain("setTimeout");
		expect(script).not.toContain("transition");
		expect(script).toContain('"system"');
		expect(script).toContain('"light"');
		expect(script).toContain('"dark"');
	});

	it("registers and wires the sidebar toggle", async () => {
		const script = await (await SELF.fetch("http://example.com/static/theme.js")).text();
		// The button and its icon/status hooks.
		expect(script).toContain("[data-theme-toggle]");
		expect(script).toContain("[data-theme-icon]");
		expect(script).toContain("[data-theme-status]");
		// The click handler is the dedicated cycle function, not an inline body:
		// emptying or renaming onToggleClick must fail here.
		expect(script).toMatch(/addEventListener\(\s*"click"\s*,\s*onToggleClick\s*\)/);
		// The exact cycle order is System -> Light -> Dark.
		expect(script).toMatch(/\[\s*"system"\s*,\s*"light"\s*,\s*"dark"\s*\]/);
		// The next state is the following choice, wrapping back to the start.
		expect(script).toContain("(index + 1) % CHOICES.length");
		// Storage is tied to the choices: System removes the entry so the device
		// preference applies again; Light and Dark store an explicit value.
		expect(script).toMatch(/choice === "system"\s*\)\s*localStorage\.removeItem\(KEY\)/);
		expect(script).toMatch(/localStorage\.setItem\(KEY,\s*choice\)/);
		// Showing/hiding an icon must toggle the `hidden` CONTENT ATTRIBUTE. Because
		// SVGElement has no `hidden` IDL property and the UA's `[hidden]` rule does
		// not match SVG elements, assigning `icons[i].hidden = ...` is a silent
		// no-op that leaves the stale icon visible. Guard against that regression.
		expect(script).toContain('toggleAttribute("hidden"');
		expect(script).not.toMatch(/\.hidden\s*=\s*icons\[/);
		expect(script).not.toMatch(/\bicons\[i\]\.hidden\b/);
		// Both the accessible name and tooltip are updated from one table.
		expect(script).toContain("aria-label");
		expect(script).toContain("title");
		// The live region announces post-init changes only.
		expect(script).toMatch(/Theme set to/);
	});

	it("uses the exact accessible names for the toggle", async () => {
		const script = await (await SELF.fetch("http://example.com/static/theme.js")).text();
		for (const name of [
			"Theme: Auto (system). Switch to Light.",
			"Theme: Light. Switch to Dark.",
			"Theme: Dark. Switch to Auto.",
		]) {
			expect(script).toContain(name);
		}
	});

	it("server-renders the toggle with the Auto accessible name and tooltip", async () => {
		const html = await getPage(session, "/");
		const toggle = html.split("data-theme-toggle")[1]?.split(">")[0] ?? "";
		expect(toggle).toContain('aria-label="Theme: Auto (system). Switch to Light."');
		expect(toggle).toContain('title="Theme: Auto (system). Switch to Light."');
	});

	it("carries the hidden attribute on the non-active SVGs and a scoped rule to honour it", async () => {
		const html = await getPage(session, "/");
		// The server-rendered markup hides light and dark, leaving system visible.
		const tag = (icon: string) => html.match(new RegExp(`<svg[^>]*data-theme-icon="${icon}"[^>]*>`))?.[0] ?? "";
		expect(tag("system")).not.toBe("");
		expect(tag("system")).not.toMatch(/\shidden[\s>]/);
		expect(tag("light")).toMatch(/\shidden>/);
		expect(tag("dark")).toMatch(/\shidden>/);
		// SVG elements do not match the UA `[hidden]` rule, so the stylesheet must
		// supply one scoped to the toggle, and must not add a broad unscoped rule.
		expect(styles).toMatch(/\.theme-toggle\s+svg\[hidden\]\s*\{\s*display:\s*none/);
		expect(styles).not.toMatch(/^\s*\[hidden\]/m);
	});
});
