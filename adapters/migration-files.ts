import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Migration } from "../src/migrations.js";

/**
 * Reads `NNNN_name.sql` files from a directory, oldest first. The version is
 * the file name without its extension, so `0002_expenses.sql` sorts after
 * `0001_init.sql` and a rename is a deliberate migration of its own.
 */
export async function readMigrations(directory: string): Promise<Migration[]> {
	const files = (await readdir(resolve(directory)))
		.filter((file) => file.endsWith(".sql"))
		.sort();

	return await Promise.all(
		files.map(async (file) => ({
			version: file.replace(/\.sql$/, ""),
			sql: await readFile(resolve(directory, file), "utf8"),
		})),
	);
}