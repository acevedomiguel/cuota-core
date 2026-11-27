import { afterAll } from "vitest";
import pkg from "../package.json";
import { fileAssets } from "../adapters/assets.js";
import { memoryReceipts } from "../adapters/receipts.js";
import { createCuotaApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { openTestDatabase, usingPostgres } from "./dialect.js";

/**
 * The test host: an empty database (SQLite in memory, or PostgreSQL when
 * `TEST_DATABASE_URL` is set), the repository's own static files, and a fixed
 * config. Each test file gets a fresh module graph, so each one starts with an
 * empty database.
 */

const test = await openTestDatabase();

export const database = test.db;
export const dialect = usingPostgres ? "postgres" : "sqlite";

afterAll(async () => {
	await test.close();
});

export const testConfig: AppConfig = {
	// The third allowlisted email exists so the two-account limit is testable:
	// the allowlist admits it, and the server still refuses a third account.
	allowedEmails: ["mike@example.com", "richel@example.com", "third@example.com"],
	passkeys: { rpId: "localhost", origin: "http://localhost", rpName: "Cuota" },
	invoiceReader: { apiKey: "test-deepseek-key" },
	version: pkg.version,
	about: {
		builtBy: "Example Maintainer",
		email: "maintainer@example.com",
		github: "https://github.com/example",
		deployed: { label: "v9.9.9", at: "2026-01-02 03:04 UTC" },
	},
};

export const app = createCuotaApp({
	database,
	config: testConfig,
	assets: fileAssets(new URL("../public", import.meta.url).pathname),
	receipts: memoryReceipts(),
});

/** The database, under the name the ported tests already use. */
export const env = { DB: database };

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * A fetch-shaped alias for the app. Browser `fetch` follows redirects unless
 * told otherwise, and the ported tests rely on that; `app.request` never does.
 * The two are reconciled here so a test reads exactly as it did before.
 */
export const SELF = {
	fetch: async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
		const start = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		let response = await app.request(input as string | URL | Request, init);
		if (init.redirect === "manual") return response;

		let method = init.method ?? "GET";
		const headers = new Headers(init.headers);
		let body = init.body;
		let url = start;

		for (let hop = 0; hop < 5 && REDIRECTS.has(response.status); hop += 1) {
			const location = response.headers.get("location");
			if (!location) break;
			url = new URL(location, url).toString();

			// 303 always becomes a bodyless GET; so does a POST after 301/302,
			// which is what browsers have done since forever.
			const toGet = response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST");
			if (toGet) {
				method = "GET";
				body = undefined;
				headers.delete("content-type");
				headers.delete("content-length");
			}

			response = await app.request(url, { method, headers, body });
		}

		return response;
	},
};