#!/usr/bin/env node
/**
 * End-to-end smoke test against a running instance. Uses only HTTP, so it can
 * check a container without reaching inside it.
 *
 * The instance must allow SMOKE_EMAIL to sign up (ALLOWED_EMAILS).
 *
 *   BASE_URL=http://127.0.0.1:3000 SMOKE_EMAIL=smoke@example.com npm run smoke
 */

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const EMAIL = process.env.SMOKE_EMAIL ?? "smoke@example.com";
const PASSWORD = process.env.SMOKE_PASSWORD ?? "smoke-password-123";

let cookie = "";
const failures = [];

function absorb(res) {
	const set = res.headers.getSetCookie?.() ?? [];
	if (set.length > 0) cookie = set.map((entry) => entry.split(";")[0]).join("; ");
}

async function request(path, init = {}) {
	const headers = new Headers(init.headers);
	if (cookie) headers.set("cookie", cookie);
	if (init.body && !headers.has("content-type")) {
		headers.set("content-type", "application/x-www-form-urlencoded");
	}
	const res = await fetch(BASE + path, { ...init, headers, redirect: "manual" });
	absorb(res);
	return res;
}

function csrfOf(html) {
	const token = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
	if (!token) throw new Error("no CSRF token in that page — is the app running?");
	return token;
}

function check(name, ok, detail = "") {
	if (ok) {
		console.log(`ok   ${name}`);
		return;
	}
	failures.push(name);
	console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

async function page(path) {
	const res = await request(path);
	return { status: res.status, html: await res.text() };
}

function resetCookie() {
	cookie = "";
}

async function main() {
	const health = await request("/healthz");
	check("/healthz answers 200", health.status === 200, `got ${health.status}`);

	let res = await request("/login");
	let html = await res.text();
	check("GET /login renders", res.status === 200 && html.includes("Sign in"));

	res = await request("/signup", {
		method: "POST",
		body: new URLSearchParams({ _csrf: csrfOf(html), email: EMAIL, name: "Smoke Test", password: PASSWORD }),
	});
	check("POST /signup creates or accepts the account", res.status === 303 || res.status === 400, `got ${res.status}`);

	resetCookie();
	res = await request("/login");
	html = await res.text();

	res = await request("/login", {
		method: "POST",
		body: new URLSearchParams({ _csrf: csrfOf(html), email: EMAIL, password: PASSWORD }),
	});
	check("POST /login signs in", res.status === 303, `got ${res.status}`);

	const home = await page("/");
	check("GET / renders the dashboard", home.status === 200 && home.html.includes("/static/styles.css"), `got ${home.status}`);
	const csrf = csrfOf(home.html);

	res = await request("/incomes", {
		method: "POST",
		body: new URLSearchParams({ _csrf: csrf, userId: "1", amount: "5000" }),
	});
	check("POST /incomes records a salary", res.status === 303, `got ${res.status}`);

	const today = new Date().toISOString().slice(0, 10);
	res = await request("/add", {
		method: "POST",
		body: new URLSearchParams({
			_csrf: csrf,
			amount: "25.50",
			description: "Smoke coffee",
			payer: "me",
			date: today,
			category: "uncategorized",
		}),
	});
	check("POST /add records an expense", res.status === 303, `got ${res.status}`);

	const after = await page("/");
	check("the expense appears on the dashboard", after.status === 200 && after.html.includes("Smoke coffee"));

	check("GET /analytics renders", (await page("/analytics")).status === 200);
	check("GET /settings renders", (await page("/settings")).status === 200);
	check("GET /about renders", (await page("/about")).status === 200);

	res = await request("/logout", {
		method: "POST",
		body: new URLSearchParams({ _csrf: csrfOf(after.html) }),
	});
	check("POST /logout signs out", res.status === 303, `got ${res.status}`);

	res = await request("/");
	check("signed-out / redirects to /login", res.status === 303 && res.headers.get("location") === "/login");

	if (failures.length > 0) {
		console.error(`\n${failures.length} smoke check(s) failed`);
		process.exit(1);
	}
	console.log("\nall smoke checks passed");
}

await main();