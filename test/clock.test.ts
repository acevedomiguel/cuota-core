import { describe, expect, it } from "vitest";
import { makeStrictClock } from "../adapters/clock.js";

describe("makeStrictClock", () => {
	it("passes through a moving clock unchanged", async () => {
		let tick = "2026-11-27T10:00:00.000Z";
		const clock = makeStrictClock(async () => tick);
		const first = await clock();
		tick = "2026-11-27T10:00:00.500Z"; // the real clock advanced normally
		const second = await clock();
		expect(first).toBe("2026-11-27T10:00:00.000Z");
		expect(second).toBe("2026-11-27T10:00:00.500Z");
	});

	it("bumps by one millisecond when the clock has not advanced", async () => {
		// The underlying clock is frozen: two writes in the same millisecond
		// would otherwise share an instant.
		const frozen = "2026-11-27T10:00:00.000Z";
		const clock = makeStrictClock(async () => frozen);

		const a = await clock();
		const b = await clock();
		const c = await clock();

		expect(a).toBe(frozen);
		expect(b).toBe("2026-11-27T10:00:00.001Z");
		expect(c).toBe("2026-11-27T10:00:00.002Z");
		expect(a < b && b < c).toBe(true);
	});

	it("never goes backwards when the database clock is behind", async () => {
		// A clock that drifts backwards must not shrink the timeline: the last
		// stamped value always wins.
		let next = "2026-11-27T10:00:00.050Z";
		const clock = makeStrictClock(async () => next);

		const a = await clock();
		next = "2026-11-27T10:00:00.010Z"; // database clock moved backwards
		const b = await clock();
		expect(a).toBe("2026-11-27T10:00:00.050Z");
		expect(b).toBe("2026-11-27T10:00:00.051Z");
	});

	it("rejects a malformed clock value instead of fabricating a timestamp", async () => {
		const clock = makeStrictClock(async () => "not-a-time");
		await expect(clock()).rejects.toThrow(/malformed/);
	});
});
