import { describe, expect, it } from "vitest";
import { openSqliteDatabase } from "../adapters/sqlite.js";

/**
 * The contract every `SqlDatabase` implementation must satisfy. These run
 * against the in-repo SQLite adapter today; a PostgreSQL adapter is expected to
 * pass the same assertions.
 */

async function userTable() {
	const db = openSqliteDatabase();
	await db.exec(`
		CREATE TABLE t (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			v TEXT NOT NULL,
			at TEXT NOT NULL
		);
	`);
	return db;
}

describe("SqlDatabase contract", () => {
	it("returns the inserted id through RETURNING", async () => {
		const db = await userTable();
		const first = await db.prepare("INSERT INTO t (v, at) VALUES (?, ?) RETURNING id").bind("a", "x").first<{ id: number }>();
		const second = await db.prepare("INSERT INTO t (v, at) VALUES (?, ?) RETURNING id").bind("b", "x").first<{ id: number }>();
		expect(first?.id).toBe(1);
		expect(second?.id).toBe(2);
	});

	it("reports how many rows a write touched", async () => {
		const db = await userTable();
		await db.prepare("INSERT INTO t (v, at) VALUES (?, ?)").bind("a", "x").run();
		await db.prepare("INSERT INTO t (v, at) VALUES (?, ?)").bind("b", "x").run();

		expect((await db.prepare("UPDATE t SET v = ? WHERE id = ?").bind("z", 1).run()).meta.changes).toBe(1);
		expect((await db.prepare("UPDATE t SET v = ? WHERE id = ?").bind("z", 99).run()).meta.changes).toBe(0);
		expect((await db.prepare("DELETE FROM t WHERE v = ?").bind("z").run()).meta.changes).toBe(1);
	});

	it("reads one row with first() and many with all()", async () => {
		const db = await userTable();
		await db.prepare("INSERT INTO t (v, at) VALUES (?, ?)").bind("b", "x").run();
		await db.prepare("INSERT INTO t (v, at) VALUES (?, ?)").bind("a", "x").run();

		expect(await db.prepare("SELECT * FROM t WHERE id = ?").bind(99).first()).toBeNull();
		const { results } = await db.prepare("SELECT v FROM t ORDER BY v ASC").all<{ v: string }>();
		expect(results.map((r) => r.v)).toEqual(["a", "b"]);
	});

	it("exposes a millisecond ISO clock whose text order is time order", async () => {
		const db = await userTable();
		const now = await db.now();
		expect(now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(Number.isNaN(Date.parse(now))).toBe(false);
		expect(now < new Date(Date.parse(now) + 1).toISOString()).toBe(true);
	});
});