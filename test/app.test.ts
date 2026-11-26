import { env, SELF } from "./harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import initSql from "../migrations/0001_init.sql?raw";

beforeAll(async () => {
	// The session middleware reads/writes the settings table, so the schema
	// must exist before any request is served.
	await env.DB.exec(initSql.replace(/\n/g, " "));
});

describe("app shell", () => {
	it("GET / returns the styled home page", async () => {
		const res = await SELF.fetch("http://example.com/");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(await res.text()).toContain("cuo");
	});

	it("GET /static/styles.css serves the copied stylesheet", async () => {
		const res = await SELF.fetch("http://example.com/static/styles.css");
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("--accent");
	});
});
