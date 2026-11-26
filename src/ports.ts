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
	 * not the process's, and string comparison stays chronological. Two writes
	 * in the same millisecond share an instant; callers that need a strict
	 * order must not rely on the clock alone.
	 */
	now(): Promise<string>;
}

/** Serves `/static/*`. A Worker binding, a directory, or an in-memory map. */
export interface AssetHandler {
	fetch(request: Request): Response | Promise<Response>;
}

/** Per-request session store. */
export interface Session {
	get<T>(key: string): T | undefined;
	set(key: string, value: unknown): void;
	clear(): void;
	destroy(): void;
}