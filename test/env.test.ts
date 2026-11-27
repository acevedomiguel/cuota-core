import { describe, expect, it } from "vitest";
import { loadSettings } from "../server/env.js";

// A fixed start instant keeps the assertions deterministic; the production path
// passes the process start time from server/main.ts.
const startedAt = new Date("2026-01-02T03:04:05.000Z");
const deployedAt = "2026-01-02 03:04 UTC";

describe("loadSettings deployment metadata", () => {
	it("names the running version and the start time for the about page", () => {
		const { config } = loadSettings({ APP_VERSION: "1.2.3" }, startedAt);
		expect(config.about?.deployed).toEqual({ label: "1.2.3", at: deployedAt });
	});

	it("falls back to the default version when APP_VERSION is unset", () => {
		const { config } = loadSettings({}, startedAt);
		expect(config.about?.deployed?.label).toBe("0.0.0-dev");
		expect(config.version).toBe("0.0.0-dev");
	});

	it("reports the deployment even when no contact variables are set", () => {
		const { config } = loadSettings({}, startedAt);
		expect(config.about?.deployed).toEqual({ label: "0.0.0-dev", at: deployedAt });
		expect(config.about?.builtBy).toBeUndefined();
		expect(config.about?.email).toBeUndefined();
		expect(config.about?.github).toBeUndefined();
	});

	it("keeps the contact block alongside the deployment", () => {
		const { config } = loadSettings(
			{
				APP_VERSION: "1.2.3",
				ABOUT_BUILT_BY: "Example Maintainer",
				ABOUT_EMAIL: "maintainer@example.com",
				ABOUT_GITHUB: "https://github.com/example",
			},
			startedAt,
		);
		expect(config.about).toMatchObject({
			builtBy: "Example Maintainer",
			email: "maintainer@example.com",
			github: "https://github.com/example",
			deployed: { label: "1.2.3", at: deployedAt },
		});
	});

	it("trims APP_VERSION before using it as the label", () => {
		const { config } = loadSettings({ APP_VERSION: "  v9.9.9  " }, startedAt);
		expect(config.about?.deployed?.label).toBe("v9.9.9");
	});
});
