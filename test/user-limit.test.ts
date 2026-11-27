import { env } from "./harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import { userCount } from "../src/setup.js";
import { initDb, postForm, startSession, signUpAndLogIn } from "./helpers.js";

/**
 * MIL-33: Cuota is one couple, so at most two accounts may exist. The limit is
 * enforced by the server (the database decides, in the insert), not only by
 * hiding the signup page. This file gets its own empty database, and the
 * harness allowlist admits a third email so the refusal is exercised.
 *
 * The cases run in order and share the file's database on purpose: the point is
 * the state as accounts accumulate.
 */

const FIRST = "mike@example.com";
const SECOND = "richel@example.com";
const THIRD = "third@example.com";
const PASSWORD = "twelve-chars-ok";

beforeAll(initDb);

describe("two-account limit", () => {
	it("accepts the first account through first-run setup", async () => {
		expect(await userCount(env.DB)).toBe(0);
		await signUpAndLogIn(FIRST);
		expect(await userCount(env.DB)).toBe(1);
	});

	it("accepts the second account through the invitation", async () => {
		await signUpAndLogIn(SECOND);
		expect(await userCount(env.DB)).toBe(2);
	});

	it("refuses a third allowlisted email and creates nothing", async () => {
		const res = await postForm("/signup", { email: THIRD, name: "Third", password: PASSWORD });

		expect(res.status).toBe(403);
		expect(await res.text()).toContain("two people");
		// The refusal is the server's: no third row exists.
		expect(await userCount(env.DB)).toBe(2);
	});

	it("still lets both existing accounts sign in once the limit is reached", async () => {
		for (const email of [FIRST, SECOND]) {
			const session = await startSession("/login");
			const login = await postForm("/login", { email, password: PASSWORD }, session);
			expect(login.status).toBe(303);
			expect(login.headers.get("location")).toBe("/");
		}
	});
});
