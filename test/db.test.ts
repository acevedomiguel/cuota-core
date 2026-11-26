import { env } from "./harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import initSql from "../migrations/0001_init.sql?raw";
import {
	createDbSession,
	createUser,
	deleteSetting,
	destroyDbSession,
	getSessionUserId,
	getSetting,
	getUserByEmail,
	getUserById,
	setSetting,
} from "../src/db.js";

const db = () => env.DB;

beforeAll(async () => {
	// miniflare D1 exec rejects multi-line statements; collapse newlines
	await env.DB.exec(initSql.replace(/\n/g, " "));
});

describe("users", () => {
	it("creates a user and finds it by email and id", async () => {
		const id = await createUser(db(), { email: "mike@example.com", name: "Mike", passwordHash: "pbkdf2:100000:AAAA:BBBB" });
		const byEmail = await getUserByEmail(db(), "mike@example.com");
		expect(byEmail?.id).toBe(id);
		expect((await getUserById(db(), id))?.name).toBe("Mike");
	});

	it("returns null for unknown emails and ids", async () => {
		expect(await getUserByEmail(db(), "nobody@example.com")).toBeNull();
		expect(await getUserById(db(), 999999)).toBeNull();
	});
});

describe("sessions", () => {
	it("stores sessions per user and destroys them independently", async () => {
		const a = await createUser(db(), { email: "a@example.com", name: "A", passwordHash: "x" });
		const b = await createUser(db(), { email: "b@example.com", name: "B", passwordHash: "x" });
		const sa = await createDbSession(db(), a);
		const sb = await createDbSession(db(), b);
		expect(sa).toMatch(/^[0-9a-f]{64}$/);
		expect(await getSessionUserId(db(), sa)).toBe(a);
		await destroyDbSession(db(), sb);
		expect(await getSessionUserId(db(), sb)).toBeNull();
		expect(await getSessionUserId(db(), sa)).toBe(a); // B's logout must not kill A
	});

	it("returns null for an unknown session id", async () => {
		expect(await getSessionUserId(db(), "deadbeef")).toBeNull();
	});

	it("destroys only the named session", async () => {
		const user = await createUser(db(), { email: "c@example.com", name: "C", passwordHash: "x" });
		const first = await createDbSession(db(), user);
		const second = await createDbSession(db(), user);
		await destroyDbSession(db(), first);
		expect(await getSessionUserId(db(), first)).toBeNull();
		expect(await getSessionUserId(db(), second)).toBe(user);
	});
});

describe("settings", () => {
	it("round-trip and delete", async () => {
		await setSetting(db(), "k", "v");
		expect(await getSetting(db(), "k")).toBe("v");
		await setSetting(db(), "k", "v2");
		expect(await getSetting(db(), "k")).toBe("v2");
		await deleteSetting(db(), "k");
		expect(await getSetting(db(), "k")).toBeNull();
	});
});
