import { beforeAll, describe, expect, it } from "vitest";
import { SELF } from "./harness.js";
import { getPage, initDb, signUpAndLogIn, type FormSession } from "./helpers.js";

beforeAll(initDb);

describe("desktop layout hooks", () => {
	let session: FormSession;

	beforeAll(async () => {
		session = await signUpAndLogIn("mike@example.com");
	});

	it("every authed page carries the sidebar nav; the brand links home, no Home item", async () => {
		for (const path of ["/", "/add", "/analytics", "/incomes", "/opening-balance", "/settings", "/about"]) {
			const html = await getPage(session, path);
			expect(html).toContain('class="sidebar"');
			expect(html).toContain('class="bottombar"');
			const sidebar = html.split('class="sidebar"')[1]?.split("</nav>")[0] ?? "";
			expect(sidebar).toContain('class="brand wordmark" href="/"');
			for (const href of ["/add", "/analytics", "/incomes", "/opening-balance", "/settings", "/about"]) {
				expect(sidebar).toContain(`href="${href}"`);
			}
			expect(sidebar).not.toContain(">Home</a>");
		}
	});

	it("orders the sidebar brand, menu, then theme toggle in DOM order", async () => {
		const html = await getPage(session, "/");
		const sidebar = html.split('class="sidebar"')[1]?.split("</nav>")[0] ?? "";
		const brand = sidebar.indexOf('class="brand wordmark"');
		const listEnd = sidebar.indexOf("</ul>");
		const toggle = sidebar.indexOf("data-theme-toggle");
		expect(brand).toBeGreaterThan(-1);
		expect(listEnd).toBeGreaterThan(brand);
		expect(toggle).toBeGreaterThan(listEnd);
		// The six destinations stay inside the list, after the brand and before
		// the toggle.
		for (const href of ["/add", "/analytics", "/incomes", "/opening-balance", "/settings", "/about"]) {
			expect(sidebar.indexOf(`href="${href}"`)).toBeGreaterThan(brand);
			expect(sidebar.indexOf(`href="${href}"`)).toBeLessThan(listEnd);
		}
	});

	it("renders exactly one theme toggle per authenticated sidebar", async () => {
		for (const path of ["/", "/add", "/analytics", "/incomes", "/opening-balance", "/settings", "/about"]) {
			const sidebar =
				(await getPage(session, path)).split('class="sidebar"')[1]?.split("</nav>")[0] ?? "";
			expect(sidebar.match(/data-theme-toggle/g)?.length, path).toBe(1);
		}
	});

	it("the dashboard exposes the desktop grid regions", async () => {
		const html = await getPage(session, "/");
		expect(html).toContain("dash-grid");
		expect(html).toContain("dash-hero");
		expect(html).toContain("dash-side");
		expect(html).toContain("dash-full");
	});

	it("the add form exposes the two-column grid regions", async () => {
		const html = await getPage(session, "/add");
		expect(html).toContain("form-grid");
		expect(html).toContain("form-fields");
		expect(html).toContain("form-aside");
	});

	it("form pages opt into the narrow desktop column", async () => {
		for (const path of ["/incomes", "/opening-balance", "/settings", "/about"]) {
			expect(await getPage(session, path)).toContain('class="app form-page"');
		}
	});

	it("the stylesheet carries the desktop layer", async () => {
		const css = await (await SELF.fetch("http://example.com/static/styles.css")).text();
		expect(css).toContain("min-width: 64rem");
		expect(css).toContain(".sidebar");
		expect(css).toContain("dash-grid");
	});
});
