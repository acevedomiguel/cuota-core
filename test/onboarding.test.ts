import { env, SELF } from "./harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import { initDb, postForm, refreshCsrf, signUpAndLogIn } from "./helpers.js";

beforeAll(initDb);

describe("onboarding and gate pins (review fixes)", () => {
	it("records the first salary with a single user without creating a snapshot", async () => {
		const session = await signUpAndLogIn("mike@example.com");
		await refreshCsrf(session, "/incomes");
		const res = await postForm("/incomes", { userId: "1", amount: "60000" }, session);
		expect(res.status).toBe(303);
		const snapshots = await env.DB.prepare("SELECT COUNT(*) AS n FROM snapshots").first<{ n: number }>();
		expect(snapshots!.n).toBe(0);
	});

	it("signed-out GET / redirects to /login (no public shell on /)", async () => {
		const res = await SELF.fetch("http://example.com/", { redirect: "manual" });
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/login");
	});
});
