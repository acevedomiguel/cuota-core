import type { SqlDatabase } from "./ports.js";

/**
 * A migration is a version and a script. The runner stays runtime-neutral: it
 * only needs the `SqlDatabase` port, so the same logic applies on SQLite,
 * PostgreSQL, or a serverless binding. Reading files from disk is the host's
 * job (see `adapters/migration-files.ts`).
 */
export interface Migration {
	/** Sortable, unique: `0001_init`. */
	version: string;
	sql: string;
}

export interface MigrationResult {
	applied: string[];
	skipped: string[];
}

const LEDGER = "schema_migrations";

async function applyOne(db: SqlDatabase, migration: Migration): Promise<void> {
	await db.exec(migration.sql);
	await db
		.prepare(`INSERT INTO ${LEDGER} (version, applied_at) VALUES (?, ?)`)
		.bind(migration.version, await db.now())
		.run();
}

/**
 * Applies every migration not yet recorded, oldest first, and records it.
 * Idempotent: running it twice applies nothing the second time. Versions are
 * compared as strings, which is why they are zero-padded.
 *
 * Each migration and its ledger row run in one transaction when the engine
 * supports it. Without that, a migration which half-applies (a table created,
 * the process killed before the ledger row) would be retried forever and could
 * leave the app unable to start.
 */
export async function applyMigrations(
	db: SqlDatabase,
	migrations: readonly Migration[],
): Promise<MigrationResult> {
	await db.exec(`CREATE TABLE IF NOT EXISTS ${LEDGER} (version text PRIMARY KEY, applied_at text NOT NULL)`);

	const { results } = await db.prepare(`SELECT version FROM ${LEDGER}`).all<{ version: string }>();
	const done = new Set(results.map((row) => row.version));

	const ordered = [...migrations].sort((a, b) => a.version.localeCompare(b.version));
	const applied: string[] = [];
	const skipped: string[] = [];

	for (const migration of ordered) {
		if (done.has(migration.version)) {
			skipped.push(migration.version);
			continue;
		}

		if (db.withTransaction) {
			await db.withTransaction((tx) => applyOne(tx, migration));
		} else {
			await applyOne(db, migration);
		}
		applied.push(migration.version);
	}

	return { applied, skipped };
}