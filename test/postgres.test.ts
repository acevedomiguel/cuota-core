import { describe, expect, it } from "vitest";
import { openPostgresDatabase, toPostgresPlaceholders } from "../adapters/postgres.js";
import type { SqlDatabase } from "../src/ports.js";
import { defineSqlDatabaseContract } from "./contract/sql-database.contract.js";
import { databaseUrl, usingPostgres } from "./dialect.js";

describe("placeholder translation", () => {
	it("numbers placeholders in order", () => {
		expect(toPostgresPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?")).toBe(
			"SELECT * FROM t WHERE a = $1 AND b = $2",
		);
	});

	it("leaves quoted text and identifiers alone", () => {
		expect(toPostgresPlaceholders("SELECT '?' AS q, ? AS v, \"?\" FROM t")).toBe(
			"SELECT '?' AS q, $1 AS v, \"?\" FROM t",
		);
	});

	it("does not mistake a doubled quote for the end of a string", () => {
		// SQL escapes a quote by doubling it; the scanner must stay inside the
		// literal, so the real placeholder is still first.
		expect(toPostgresPlaceholders("SELECT 'it''s ? fine' AS s, ? AS v")).toBe(
			"SELECT 'it''s ? fine' AS s, $1 AS v",
		);
	});
});

describe.skipIf(!usingPostgres)("PostgreSQL persistence", () => {
	async function fresh(): Promise<SqlDatabase> {
		const schema = `c_${crypto.randomUUID().replace(/-/g, "")}`;
		const db = await openPostgresDatabase({ connectionString: databaseUrl, schema });
		await db.exec(`
			CREATE TABLE t (
				id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
				v text NOT NULL,
				at text
			);
		`);
		return db;
	}

	defineSqlDatabaseContract("PostgreSQL adapter", fresh);

	it("applies the schema migrations once and records them", async () => {
		const { applyMigrations } = await import("../src/migrations.js");
		const { testMigrations } = await import("./dialect.js");
		const db = await openPostgresDatabase({
			connectionString: databaseUrl,
			schema: `m_${crypto.randomUUID().replace(/-/g, "")}`,
		});
		const migrations = await testMigrations();

		const first = await applyMigrations(db, migrations);
		const second = await applyMigrations(db, migrations);

		expect(first.applied).toEqual(migrations.map((m) => m.version).sort());
		expect(second.applied).toEqual([]);
		expect(second.skipped.length).toBe(migrations.length);

		const row = await db
			.prepare("SELECT COUNT(*) AS n FROM users")
			.first<{ n: number | string }>();
		expect(Number(row?.n)).toBe(0);

		await db.close();
	});
});