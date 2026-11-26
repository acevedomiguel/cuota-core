import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import * as core from "../src/index";

const ROOT = join(import.meta.dirname, "..");

const SKIP = new Set(["node_modules", ".git", "dist", "build", "coverage", "data"]);

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

/** Joins fragments so this file never contains the string it forbids. */
function literal(...parts: string[]): string {
	return parts.join("");
}

/**
 * Strings that must never appear in this repository: production identifiers
 * and personal data from the deployment this package was extracted from.
 */
const FORBIDDEN: { label: string; matches: (text: string) => boolean }[] = [
	{ label: "private deployment domain", matches: (text) => text.includes(literal("play", "garden")) },
	{ label: "cloud database binding identifier", matches: (text) => text.includes(literal("database", "_", "id")) },
	{
		label: "personal contact address",
		matches: (text) => text.includes(literal("acevedomiguel", "@", "gmail.com")),
	},
	{
		// An empty assignment is documentation; a filled one is a leaked key.
		label: "committed API key",
		matches: (text) => new RegExp(literal("DEEPSEEK_API_", "KEY", "=", "\\S")).test(text),
	},
	{ label: "cloud provider package import", matches: (text) => text.includes(literal("@", "cloudflare/")) },
	{ label: "workerd module import", matches: (text) => text.includes(literal("cloudflare", ":")) },
	{ label: "deployment CLI tooling", matches: (text) => text.includes(literal("wr", "angler")) },
	{ label: "cloud database type", matches: (text) => text.includes(literal("D1", "Database")) },
];

/** Host names that must not appear as dependencies. */
const HOST_DEPENDENCY = new RegExp(
	["cloudflare", "workerd", literal("wr", "angler")].join("|"),
	"i",
);

describe("repository hygiene", () => {
	it("contains no production identifiers or personal data", () => {
		const offenders: string[] = [];
		for (const file of walk(ROOT)) {
			const text = readFileSync(file, "utf8");
			for (const { label, matches } of FORBIDDEN) {
				if (matches(text)) offenders.push(`${relative(ROOT, file)}: ${label}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("keeps server code free of host-specific imports and browser globals", () => {
		const offenders: string[] = [];
		for (const file of walk(join(ROOT, "src"))) {
			// Views are browser-side: their inline scripts legitimately touch the
			// DOM. The generated module is their compiled form, so it is skipped
			// with them.
			if (file.endsWith(".ejs") || file.endsWith("views-compiled.ts")) continue;
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
		expect(names.filter((name) => HOST_DEPENDENCY.test(name))).toEqual([]);
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