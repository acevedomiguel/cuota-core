import { openPostgresDatabase } from "../adapters/postgres.js";
import { readMigrations } from "../adapters/migration-files.js";
import { openSqliteDatabase } from "../adapters/sqlite.js";
import type { Migration } from "../src/migrations.js";
import type { SqlDatabase } from "../src/ports.js";

/**
 * Which database the suite runs against. SQLite is the default and needs
 * nothing installed; set `TEST_DATABASE_URL` to run the same tests against a
 * real PostgreSQL server.
 */
export const databaseUrl = process.env.TEST_DATABASE_URL ?? "";
export const usingPostgres = databaseUrl !== "";

export interface TestDatabase {
	db: SqlDatabase;
	close(): Promise<void>;
}

export async function openTestDatabase(): Promise<TestDatabase> {
	if (!usingPostgres) {
		return { db: openSqliteDatabase(), close: async () => {} };
	}

	// One schema per test file: files run in parallel in the same container,
	// and a private schema keeps their tables from colliding.
	const schema = `t_${crypto.randomUUID().replace(/-/g, "")}`;
	const pg = await openPostgresDatabase({ connectionString: databaseUrl, schema });
	return { db: pg, close: () => pg.close() };
}

/** The migrations that match the running dialect. */
export async function testMigrations(): Promise<Migration[]> {
	return await readMigrations(usingPostgres ? "migrations/postgres" : "migrations");
}