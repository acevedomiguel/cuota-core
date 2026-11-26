import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { openPostgresDatabase } from "../adapters/postgres.js";
import { openSqliteDatabase } from "../adapters/sqlite.js";
import type { SqlDatabase } from "../src/ports.js";

/**
 * One variable, two engines: `postgres://…` opens PostgreSQL, anything else is
 * a SQLite file path (`file:` prefix optional). The migrations directory
 * follows the engine, so the caller never has to think about dialects.
 */

export type Engine = "postgres" | "sqlite";

export interface OpenDatabase {
	db: SqlDatabase;
	engine: Engine;
	migrationsDir: string;
	close(): Promise<void>;
}

export async function openDatabase(url: string): Promise<OpenDatabase> {
	if (/^postgres(ql)?:\/\//i.test(url)) {
		const db = await openPostgresDatabase({ connectionString: url });
		return { db, engine: "postgres", migrationsDir: "migrations/postgres", close: () => db.close() };
	}

	const path = url.startsWith("file:") ? url.slice("file:".length) : url;
	const absolute = resolve(path);
	await mkdir(dirname(absolute), { recursive: true });
	return { db: openSqliteDatabase(absolute), engine: "sqlite", migrationsDir: "migrations", close: async () => {} };
}