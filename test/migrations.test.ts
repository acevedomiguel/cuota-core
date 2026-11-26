import { describe, expect, it } from "vitest";
import { openSqliteDatabase } from "../adapters/sqlite.js";
import { applyMigrations, type Migration } from "../src/migrations.js";

/**
 * The migration runner is what a container runs before it listens. A failure
 * there must not leave a half-applied schema whose retry can never succeed.
 */

const good = (version: string, sql: string): Migration => ({ version, sql });

describe("applyMigrations", () => {
	it("applies each version once and reports what it skipped", async () => {
		const db = openSqliteDatabase();
		const migrations = [
			good("0001_init", "CREATE TABLE a (id integer);"),
			good("0002_more", "CREATE TABLE b (id integer);"),
		];

		const first = await applyMigrations(db, migrations);
		expect(first.applied).toEqual(["0001_init", "0002_more"]);
		expect(first.skipped).toEqual([]);

		const second = await applyMigrations(db, migrations);
		expect(second.applied).toEqual([]);
		expect(second.skipped).toEqual(["0001_init", "0002_more"]);
	});

	it("rolls back a migration that fails partway", async () => {
		const db = openSqliteDatabase();
		const failing = [
			good("0001_init", "CREATE TABLE a (id integer);"),
			good("0002_broken", "CREATE TABLE b (id integer); CREATE TABLE b (id integer);"),
		];

		await expect(applyMigrations(db, failing)).rejects.toThrow();

		// The first migration stands; the broken one left nothing behind, so a
		// rerun after a fix starts from a clean slate rather than a half-schema.
		const tables = await db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
			.all<{ name: string }>();
		const names = tables.results.map((row) => row.name);
		expect(names).toContain("a");
		expect(names).not.toContain("b");

		const ledger = await db
			.prepare("SELECT version FROM schema_migrations ORDER BY version")
			.all<{ version: string }>();
		expect(ledger.results.map((row) => row.version)).toEqual(["0001_init"]);
	});

	it("is idempotent when a migration contains statements that already exist", async () => {
		const db = openSqliteDatabase();
		const migrations = [good("0001_init", "CREATE TABLE IF NOT EXISTS a (id integer);")];

		await applyMigrations(db, migrations);
		// A second call sees the ledger and does not run the SQL at all.
		const second = await applyMigrations(db, migrations);
		expect(second.applied).toEqual([]);

		const row = await db
			.prepare("SELECT COUNT(*) AS n FROM schema_migrations")
			.first<{ n: number }>();
		expect(Number(row?.n)).toBe(1);
	});
});