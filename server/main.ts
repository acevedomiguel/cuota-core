import { join } from "node:path";
import { serve } from "@hono/node-server";
import { fileAssets } from "../adapters/assets.js";
import { readMigrations } from "../adapters/migration-files.js";
import { createCuotaApp } from "../src/app.js";
import { applyMigrations } from "../src/migrations.js";
import { openDatabase } from "./database.js";
import { loadSettings } from "./env.js";

/**
 * Container entry point: read the environment, open the database, apply
 * migrations, then listen. A failure here exits non-zero so the orchestrator
 * restarts or reports instead of serving a half-configured app.
 */

const settings = loadSettings();
const opened = await openDatabase(settings.databaseUrl);

try {
	const migrations = await readMigrations(opened.migrationsDir);
	const { applied } = await applyMigrations(opened.db, migrations);
	if (applied.length > 0) {
		console.log(`applied ${applied.length} migration(s): ${applied.join(", ")}`);
	}
} catch (error) {
	console.error("could not prepare the database:", error);
	await opened.close();
	process.exit(1);
}

const app = createCuotaApp({
	database: opened.db,
	config: settings.config,
	assets: fileAssets(join(process.cwd(), "public")),
	extend: (host) => {
		// Before the auth gate, so a probe does not need a session.
		host.get("/healthz", async (c) => {
			try {
				await c.get("db").prepare("SELECT 1 AS ok").first<{ ok: number }>();
				return c.json({ ok: true, engine: opened.engine, version: settings.config.version });
			} catch {
				return c.json({ ok: false }, 503);
			}
		});
	},
});

const server = serve({ fetch: app.fetch, port: settings.port, hostname: "0.0.0.0" }, (info) => {
	console.log(`cuota-core listening on http://0.0.0.0:${info.port} (${opened.engine})`);
});

/** Finish in-flight requests, close the database, then leave. */
async function shutdown(signal: string): Promise<void> {
	console.log(`${signal} received, shutting down`);
	const forced = setTimeout(() => process.exit(1), 10_000);
	forced.unref();
	server.close(async () => {
		await opened.close();
		process.exit(0);
	});
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));