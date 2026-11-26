import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import * as core from "../src/index";

const ROOT = join(import.meta.dirname, "..");

const SKIP = new Set(["node_modules", ".git", "dist", "coverage"]);

function walk(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (SKIP.has(entry.name)) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...walk(full));
		else files.push(full);
	}
	return files;
}

/**
 * Strings that must never appear in this repository: production identifiers
 * and personal data from the deployment this package was extracted from.
 *
 * Each pattern is assembled from fragments so that this file, which is itself
 * part of the scan, does not contain the string it forbids.
 */
const FORBIDDEN: { label: string; pattern: string }[] = [
	{ label: "private deployment domain", pattern: ["play", "garden"].join("") },
	{ label: "cloud database binding identifier", pattern: ["database", "_", "id"].join("") },
	{ label: "personal contact address", pattern: ["acevedomiguel", "@", "gmail.com"].join("") },
	{ label: "committed API key assignment", pattern: ["DEEPSEEK_API_", "KEY="].join("") },
	{ label: "cloud provider package import", pattern: ["@", "cloudflare/"].join("") },
	{ label: "workerd module import", pattern: ["cloudflare", ":"].join("") },
	{ label: "deployment CLI tooling", pattern: ["wr", "angler"].join("") },
	{ label: "cloud database type", pattern: ["D1", "Database"].join("") },
];

describe("repository hygiene", () => {
	it("contains no production identifiers or personal data", () => {
		const offenders: string[] = [];
		for (const file of walk(ROOT)) {
			const text = readFileSync(file, "utf8");
			for (const { label, pattern } of FORBIDDEN) {
				if (text.includes(pattern)) offenders.push(`${relative(ROOT, file)}: ${label}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("keeps src free of host-specific imports and browser globals", () => {
		const offenders: string[] = [];
		for (const file of walk(join(ROOT, "src"))) {
			const text = readFileSync(file, "utf8");
			for (const pattern of ['from "node:', "require(", "process.env", "window.", "document."]) {
				if (text.includes(pattern)) offenders.push(`${relative(ROOT, file)}: ${pattern}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});

describe("package metadata", () => {
	const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
		license?: string;
		engines?: Record<string, string>;
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};

	it("is MIT licensed and requires Node 24", () => {
		expect(pkg.license).toBe("MIT");
		expect(pkg.engines?.node).toBe(">=24");
	});

	it("depends on no host-specific runtime packages", () => {
		const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
		// Fragments again, so this assertion's own source stays clean.
		const hosts = new RegExp(FORBIDDEN.slice(4, 7).map(({ pattern }) => pattern).join("|"), "i");
		expect(names.filter((name) => hosts.test(name))).toEqual([]);
	});

	it("runs CI on Node 24", () => {
		const workflow = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
		expect(workflow).toContain("node-version: 24");
	});
});

describe("entry point", () => {
	it("loads as a module", () => {
		expect(core).toBeTypeOf("object");
	});
});