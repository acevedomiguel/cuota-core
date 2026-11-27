import { describe, expect, it } from "vitest";
import type { SqlDatabase } from "../../src/ports.js";

/**
 * The contract every `SqlDatabase` implementation must satisfy. Each adapter
 * supplies a `fresh()` that returns a database with an empty `t` table, so the
 * assertions themselves are dialect-free.
 */
export function defineSqlDatabaseContract(
	name: string,
	fresh: () => Promise<SqlDatabase>,
): void {
	describe(`${name}: SqlDatabase contract`, () => {
		it("returns the inserted id through RETURNING", async () => {
			const db = await fresh();
			const first = await db
				.prepare("INSERT INTO t (v, at) VALUES (?, ?) RETURNING id")
				.bind("a", "x")
				.first<{ id: number }>();
			const second = await db
				.prepare("INSERT INTO t (v, at) VALUES (?, ?) RETURNING id")
				.bind("b", "x")
				.first<{ id: number }>();

			expect(first?.id).toBe(1);
			expect(second?.id).toBe(2);
		});

		it("reports how many rows a write touched", async () => {
			const db = await fresh();
			await db.prepare("INSERT INTO t (v, at) VALUES (?, ?)").bind("a", "x").run();
			await db.prepare("INSERT INTO t (v, at) VALUES (?, ?)").bind("b", "x").run();

			expect((await db.prepare("UPDATE t SET v = ? WHERE id = ?").bind("z", 1).run()).meta.changes).toBe(1);
			expect((await db.prepare("UPDATE t SET v = ? WHERE id = ?").bind("z", 99).run()).meta.changes).toBe(0);
			expect((await db.prepare("DELETE FROM t WHERE v = ?").bind("z").run()).meta.changes).toBe(1);
		});

		it("reads one row with first() and many with all()", async () => {
			const db = await fresh();
			await db.prepare("INSERT INTO t (v, at) VALUES (?, ?)").bind("b", "x").run();
			await db.prepare("INSERT INTO t (v, at) VALUES (?, ?)").bind("a", "x").run();

			expect(await db.prepare("SELECT * FROM t WHERE id = ?").bind(99).first()).toBeNull();
			const { results } = await db.prepare("SELECT v FROM t ORDER BY v ASC").all<{ v: string }>();
			expect(results.map((row) => row.v)).toEqual(["a", "b"]);
		});

		it("binds null and text without confusing the two", async () => {
			const db = await fresh();
			await db.prepare("INSERT INTO t (v, at) VALUES (?, ?)").bind("x", "now").run();
			await db.prepare("UPDATE t SET at = ? WHERE v = ?").bind(null, "x").run();

			const row = await db.prepare("SELECT at FROM t WHERE v = ?").bind("x").first<{ at: string | null }>();
			expect(row?.at).toBeNull();
			expect(await db.prepare("SELECT * FROM t WHERE at = ?").bind("null").first()).toBeNull();
		});

		it("exposes a millisecond ISO clock whose text order is time order", async () => {
			const db = await fresh();
			const now = await db.now();

			expect(now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
			expect(Number.isNaN(Date.parse(now))).toBe(false);
			expect(now < new Date(Date.parse(now) + 1).toISOString()).toBe(true);
		});

		it("stamps strictly increasing instants even within one millisecond", async () => {
			const db = await fresh();
			// Back-to-back reads hit the same real millisecond, which is the
			// collision the strict clock exists to remove.
			const first = await db.now();
			const second = await db.now();
			const third = await db.now();

			expect(first < second).toBe(true);
			expect(second < third).toBe(true);
		});

		it("runs several statements in one exec", async () => {
			const db = await fresh();
			await db.exec(`
				CREATE TABLE u (id integer);
				CREATE TABLE w (id integer);
			`);
			await db.prepare("INSERT INTO u (id) VALUES (?)").bind(1).run();
			const row = await db.prepare("SELECT COUNT(*) AS n FROM u").first<{ n: number | string }>();
			expect(Number(row?.n)).toBe(1);
		});
	});
}