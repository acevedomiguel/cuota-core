import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import type { SqlDatabase, SqlStatement, SqlValue } from "../src/ports.js";

/**
 * SQLite through Node's built-in driver, used by tests and by any small
 * deployment that does not want a server. It is an adapter: the core never
 * imports it.
 */

/** node:sqlite binds only null, numbers, strings, and blobs. */
function normalize(value: SqlValue): null | number | string {
	if (typeof value === "boolean") return value ? 1 : 0;
	return value;
}

class SqliteStatement implements SqlStatement {
	private values: SqlValue[] = [];

	constructor(private readonly statement: StatementSync) {}

	bind(...values: SqlValue[]): SqlStatement {
		this.values = values;
		return this;
	}

	async first<T = Record<string, unknown>>(): Promise<T | null> {
		const row = this.statement.get(...(this.values.map(normalize) as never[]));
		return (row ?? null) as T | null;
	}

	async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
		const results = this.statement.all(...(this.values.map(normalize) as never[])) as T[];
		return { results };
	}

	async run(): Promise<{ meta: { changes: number } }> {
		const result = this.statement.run(...(this.values.map(normalize) as never[]));
		return { meta: { changes: Number(result.changes) } };
	}
}

class SqliteDatabase implements SqlDatabase {
	constructor(private readonly db: DatabaseSync) {}

	prepare(sql: string): SqlStatement {
		return new SqliteStatement(this.db.prepare(sql));
	}

	async exec(sql: string): Promise<void> {
		this.db.exec(sql);
	}

	async now(): Promise<string> {
		const row = this.db
			.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now")
			.get() as { now: string } | undefined;
		if (!row) throw new Error("could not read the database clock");
		return row.now;
	}

	async withTransaction<T>(work: (db: SqlDatabase) => Promise<T>): Promise<T> {
		this.db.exec("BEGIN");
		try {
			const result = await work(this);
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
}

/** Opens an in-memory database by default: a fresh one per caller. */
export function openSqliteDatabase(path = ":memory:"): SqlDatabase {
	return new SqliteDatabase(new DatabaseSync(path));
}