/**
 * cuota-core
 *
 * Runtime-neutral core for a two-person shared expense app: expenses split in
 * proportion to each person's income as it stood when the expense was recorded.
 *
 * A host supplies three things — a database driver, a config, and a static
 * asset handler — and gets a Hono app back. Nothing in `src/` imports
 * Cloudflare Workers types, Node built-ins, or any specific deployment
 * runtime, so the same build runs in a container, on a serverless runtime, or
 * in a test.
 */
export { createCuotaApp } from "./app.js";
export type { CuotaAppOptions } from "./app.js";
export type { AppEnv } from "./app-env.js";
export type { AboutConfig, AppConfig, InvoiceReaderConfig, PasskeyConfig } from "./config.js";
export type { AssetHandler, Session, SqlDatabase, SqlStatement, SqlValue } from "./ports.js";