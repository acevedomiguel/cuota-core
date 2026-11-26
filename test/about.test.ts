import { SELF } from "./harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import pkg from "../package.json";
import { getPage, initDb, signUpAndLogIn, type FormSession } from "./helpers.js";

beforeAll(initDb);

/** The sidebar nav is the first `class="sidebar"` nav up to its closing tag. */
function sidebarOf(html: string): string {
	return html.split('class="sidebar"')[1]?.split("</nav>")[0] ?? "";
}

/** The mobile bottom bar is the `class="bottombar"` nav up to its closing tag. */
function bottombarOf(html: string): string {
	return html.split('class="bottombar"')[1]?.split("</nav>")[0] ?? "";
}

describe("about page", () => {
	it("redirects signed-out requests to login", async () => {
		const res = await SELF.fetch("http://example.com/about", { redirect: "manual" });
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/login");
	});

	let session: FormSession;

	beforeAll(async () => {
		session = await signUpAndLogIn("mike@example.com");
	});

	it("renders the one-line summary for a signed-in user", async () => {
		const res = await SELF.fetch("http://example.com/about", {
			headers: { cookie: session.cookie },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();
		expect(html).toContain("<title>About · cuota</title>");
		expect(html).toContain("your share");
		expect(html).toContain("private, two-person expense tracker");
		expect(html).toContain("income");
	});

	it("shows the configured contact block", async () => {
		const html = await getPage(session, "/about");
		expect(html).toContain("Example Maintainer");
		expect(html).toContain('href="mailto:maintainer@example.com"');
		expect(html).toContain('href="https://github.com/example"');
	});

	it("shows what the host says is deployed, when it can say", async () => {
		const html = await getPage(session, "/about");
		expect(html).toContain("Deployed");
		expect(html).toContain("v9.9.9");
		expect(html).toContain("2026-01-02 03:04 UTC");
	});

	it("hardcodes no deployment's own contact details", async () => {
		const html = await getPage(session, "/about");
		expect(html).not.toContain("@gmail.com");
		expect(html).not.toContain(["play", "garden"].join(""));
	});

	it("shows the release version from package.json", async () => {
		const html = await getPage(session, "/about");
		expect(html).toContain(`<dd>${pkg.version}</dd>`);
	});

	it("drops the old long-form sections", async () => {
		const html = await getPage(session, "/about");
		expect(html).not.toContain("A split that changes with you");
		expect(html).not.toContain("From spreadsheet to app");
		expect(html).not.toContain("Private by design");
	});
});

describe("about navigation", () => {
	let session: FormSession;

	beforeAll(async () => {
		session = await signUpAndLogIn("mike@example.com");
	});

	it("lists About in the sidebar as the single current page", async () => {
		const html = await getPage(session, "/about");
		const sidebar = sidebarOf(html);

		expect(sidebar).toContain('href="/about"');
		expect(sidebar).toContain('class="active"');
		expect(sidebar).toContain('aria-current="page"');
		// Exactly one page claims to be current.
		expect(html.match(/aria-current="page"/g) ?? []).toHaveLength(1);
	});

	it("does not add About to the mobile bottom bar", async () => {
		const html = await getPage(session, "/about");
		expect(bottombarOf(html)).not.toContain('href="/about"');
	});

	it("leaves other pages' active state intact", async () => {
		const sidebar = sidebarOf(await getPage(session, "/settings"));
		expect(sidebar).toContain('href="/settings"');
		expect(sidebar).toContain('aria-current="page"');
		expect(sidebar).not.toContain('href="/about" class="active"');
	});

	it("links to About Cuota from Settings", async () => {
		const html = await getPage(session, "/settings");
		expect(html).toMatch(/<a href="\/about"[^>]*>About Cuota<\/a>/);
	});
});
