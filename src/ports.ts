/**
 * The ports a host provides. Nothing here imports a runtime: the same shapes
 * are implemented by the in-repo SQLite adapter, a serverless database
 * binding, or PostgreSQL.
 */

/** A value a statement can bind. */
export type SqlValue = string | number | boolean | null;

/**
 * One prepared statement. Deliberately mirrors the call shapes most SQL
 * runtimes converge on, without exposing any vendor's result metadata:
 * inserts that need the new id end with `RETURNING id` and read it with
 * `first()`.
 */
export interface SqlStatement {
	bind(...values: SqlValue[]): SqlStatement;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
	run(): Promise<{ meta: { changes: number } }>;
}

export interface SqlDatabase {
	prepare(sql: string): SqlStatement;
	/** Runs a migration file: several statements, comments, no bindings. */
	exec(sql: string): Promise<void>;
	/**
	 * The database clock as millisecond ISO text (`2026-11-26T09:00:00.000Z`).
	 * Every stored timestamp comes from here, so ordering is the database's,
	 * not the process's, and string comparison stays chronological. The
	 * adapters guarantee strict monotonicity: each read returns a value
	 * strictly later than the previous read on the same database instance, so
	 * write order equals timestamp order and a row never shares an instant
	 * with the one written just before it.
	 */
	now(): Promise<string>;
	/**
	 * Runs `work` atomically on one connection. The argument is a database
	 * bound to the transaction, so statements inside `work` must use it rather
	 * than the outer object.
	 *
	 * Optional: engines without interactive transactions (a serverless binding,
	 * for example) omit it, and the migration runner then runs each migration
	 * plainly. Their schema is managed by the platform's own tooling.
	 */
	withTransaction?<T>(work: (db: SqlDatabase) => Promise<T>): Promise<T>;
}

/** Serves `/static/*`. A Worker binding, a directory, or an in-memory map. */
export interface AssetHandler {
	fetch(request: Request): Response | Promise<Response>;
}

/**
 * Stores receipt images. The bytes live outside the ledger (a bucket, a
 * directory, or memory); this port only needs to put, get, and drop one object
 * by an opaque key, so the same app runs on every host.
 */
export interface ReceiptStore {
	put(key: string, body: Uint8Array, contentType: string): Promise<void>;
	get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
	delete(key: string): Promise<void>;
}

/** Per-request session store. */
export interface Session {
	get<T>(key: string): T | undefined;
	set(key: string, value: unknown): void;
	clear(): void;
	destroy(): void;
}