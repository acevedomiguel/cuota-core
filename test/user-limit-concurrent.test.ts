import { env } from "./harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import { createUser, createUserWithinLimit, UserLimitReachedError } from "../src/db.js";
import { userCount } from "../src/setup.js";
import { initDb } from "./helpers.js";

/**
 * The two-account limit must hold when two signups arrive together, not only in
 * sequence. A plain "count then insert" lets both read the same count and each
 * insert; this test starts two limited creates concurrently from a one-account
 * household and asserts only one can win.
 *
 * On the synchronous SQLite driver the two calls run one after the other; on
 * PostgreSQL (the CI job with TEST_DATABASE_URL) they genuinely overlap, which
 * is where the lock matters.
 */
beforeAll(initDb);

describe("two-account limit under concurrency", () => {
	it("lets only one of two racing signups become the second account", async () => {
		await createUser(env.DB, { email: "first@example.com", name: "First", passwordHash: "h" });
		expect(await userCount(env.DB)).toBe(1);

		const results = await Promise.allSettled([
			createUserWithinLimit(env.DB, { email: "a@example.com", name: "A", passwordHash: "h" }),
			createUserWithinLimit(env.DB, { email: "b@example.com", name: "B", passwordHash: "h" }),
		]);

		// The invariant: never a third account.
		expect(await userCount(env.DB)).toBe(2);

		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r) => r.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(UserLimitReachedError);
	});

	it("never exceeds two when several signups race from an empty database", async () => {
		// A fresh deployment: no accounts at all, which is the state where a lock
		// on an existing users row would have nothing to lock.
		await env.DB.prepare("DELETE FROM users").run();
		expect(await userCount(env.DB)).toBe(0);

		const results = await Promise.allSettled([
			createUserWithinLimit(env.DB, { email: "one@example.com", name: "One", passwordHash: "h" }),
			createUserWithinLimit(env.DB, { email: "two@example.com", name: "Two", passwordHash: "h" }),
			createUserWithinLimit(env.DB, { email: "three@example.com", name: "Three", passwordHash: "h" }),
		]);

		// Two accounts is the limit; the third attempt must lose.
		expect(await userCount(env.DB)).toBe(2);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
	});
});
