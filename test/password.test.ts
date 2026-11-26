import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth.js";

describe("PBKDF2 password hashing", () => {
	it("hashes as pbkdf2:100000:<salt-b64>:<hash-b64> and verifies only the matching password", async () => {
		const encoded = await hashPassword("correct-horse-123");
		const parts = encoded.split(":");
		expect(parts.length).toBe(4);
		expect(parts[0]).toBe("pbkdf2");
		expect(parts[1]).toBe("100000");
		expect(parts[2]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
		expect(parts[3]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
		expect(parts[2]).not.toBe((await hashPassword("correct-horse-123")).split(":")[2]);

		expect(await verifyPassword("correct-horse-123", encoded)).toBe(true);
		expect(await verifyPassword("wrong-password", encoded)).toBe(false);
	});

	it("rejects malformed hashes and legacy scrypt hashes", async () => {
		expect(await verifyPassword("x", "")).toBe(false);
		expect(await verifyPassword("x", "pbkdf2")).toBe(false);
		expect(await verifyPassword("x", "scrypt:16384:8:1:AAAA:BBBB")).toBe(false);
		expect(await verifyPassword("x", "pbkdf2:abc:AAAA:BBBB")).toBe(false);
	});

	it("verifies within the Workers CPU budget", async () => {
		const encoded = await hashPassword("correct-horse-123");
		const start = performance.now();
		await verifyPassword("correct-horse-123", encoded);
		expect(performance.now() - start).toBeLessThan(50);
	});
});
