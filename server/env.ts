import type { AboutConfig, AppConfig } from "../src/config.js";

/**
 * Turns environment variables into the app config and the bits only the server
 * needs. Every variable is documented in `.env.example`; nothing here has a
 * secret baked in, and optional features stay off when their variables are
 * absent.
 */

export interface ServerSettings {
	port: number;
	databaseUrl: string;
	/** Directory the container keeps receipt photos in. */
	receiptsDir: string;
	config: AppConfig;
}

function csv(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function portOf(raw: string | undefined): number {
	const port = Number(raw ?? 3000);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`PORT must be a whole number between 1 and 65535, got ${JSON.stringify(raw)}`);
	}
	return port;
}

/** Formats an instant as `YYYY-MM-DD HH:MM UTC`, the shape the about page shows. */
function formatDeployedAt(at: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} ` +
		`${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`
	);
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env, startedAt: Date = new Date()): ServerSettings {
	const rpId = env.PASSKEY_RP_ID?.trim();
	const origin = env.PASSKEY_ORIGIN?.trim();

	if (Boolean(rpId) !== Boolean(origin)) {
		throw new Error("PASSKEY_RP_ID and PASSKEY_ORIGIN must be set together, or neither to disable passkeys");
	}

	const version = env.APP_VERSION?.trim() || "0.0.0-dev";

	// A container can always name what is running, so the about page carries the
	// version and the instant this process started. A host that cannot say omits
	// the row instead.
	const about: AboutConfig = {
		...(env.ABOUT_BUILT_BY ? { builtBy: env.ABOUT_BUILT_BY } : {}),
		...(env.ABOUT_EMAIL ? { email: env.ABOUT_EMAIL } : {}),
		...(env.ABOUT_GITHUB ? { github: env.ABOUT_GITHUB } : {}),
		deployed: { label: version, at: formatDeployedAt(startedAt) },
	};

	const apiKey = env.DEEPSEEK_API_KEY?.trim();

	const config: AppConfig = {
		allowedEmails: csv(env.ALLOWED_EMAILS),
		passkeys: rpId && origin ? { rpId, origin, rpName: env.PASSKEY_RP_NAME?.trim() || "Cuota" } : null,
		invoiceReader: apiKey ? { apiKey, ...(env.DEEPSEEK_MODEL ? { model: env.DEEPSEEK_MODEL } : {}) } : null,
		version,
		setupToken: env.SETUP_TOKEN?.trim() || undefined,
		about,
	};

	return {
		port: portOf(env.PORT),
		databaseUrl: env.DATABASE_URL?.trim() || "file:./data/cuota.db",
		receiptsDir: env.RECEIPTS_DIR?.trim() || "./data/receipts",
		config,
	};
}
