import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ReceiptStore } from "../src/ports.js";

/**
 * Receipt storage for the container and the tests. A serverless host passes its
 * own binding instead; both satisfy the same three methods.
 */

/** Keeps receipt bytes in memory. Tests use it; nothing survives a restart. */
export function memoryReceipts(): ReceiptStore {
	const objects = new Map<string, { body: Uint8Array; contentType: string }>();
	return {
		async put(key, body, contentType) {
			objects.set(key, { body, contentType });
		},
		async get(key) {
			return objects.get(key) ?? null;
		},
		async delete(key) {
			objects.delete(key);
		},
	};
}

/** Keeps receipt bytes in a directory, one file per object key. */
export function fileReceipts(directory: string): ReceiptStore {
	const root = resolve(directory);

	/** A key is opaque, but never let one escape the directory. */
	function pathFor(key: string): string {
		if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error("receipt key must be a plain identifier");
		return join(root, key);
	}

	return {
		async put(key, body, contentType) {
			await mkdir(root, { recursive: true });
			await writeFile(pathFor(key), body);
			await writeFile(`${pathFor(key)}.type`, contentType, "utf8");
		},

		async get(key) {
			try {
				const body = await readFile(pathFor(key));
				const contentType = await readFile(`${pathFor(key)}.type`, "utf8");
				return { body, contentType };
			} catch {
				return null;
			}
		},

		async delete(key) {
			await rm(pathFor(key), { force: true });
			await rm(`${pathFor(key)}.type`, { force: true });
		},
	};
}
