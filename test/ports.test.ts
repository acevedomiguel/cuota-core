import { openSqliteDatabase } from "../adapters/sqlite.js";
import type { SqlDatabase } from "../src/ports.js";
import { defineSqlDatabaseContract } from "./contract/sql-database.contract.js";

async function fresh(): Promise<SqlDatabase> {
	const db = openSqliteDatabase();
	await db.exec(`
		CREATE TABLE t (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			v TEXT NOT NULL,
			at TEXT
		);
	`);
	return db;
}

defineSqlDatabaseContract("SQLite adapter", fresh);