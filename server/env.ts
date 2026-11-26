import type { AppConfig } from "../src/config.js";

/**
 * Turns environment variables into the app config and the bits only the server
 * needs. Every variable is documented in `.env.example`; nothing here has a
 * secret baked in, and optional features stay off when their variables are
 * absent.
 */

export interface ServerSettings {
	port: number;
	databaseUrl: string;
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

export function loadSettings(env: NodeJS.ProcessEnv = process.env): ServerSettings {
	const rpId = env.PASSKEY_RP_ID?.trim();
	const origin = env.PASSKEY_ORIGIN?.trim();

	if (Boolean(rpId) !== Boolean(origin)) {
		throw new Error("PASSKEY_RP_ID and PASSKEY_ORIGIN must be set together, or neither to disable passkeys");
	}

	const about =
		env.ABOUT_BUILT_BY || env.ABOUT_EMAIL || env.ABOUT_GITHUB
			? {
					...(env.ABOUT_BUILT_BY ? { builtBy: env.ABOUT_BUILT_BY } : {}),
					...(env.ABOUT_EMAIL ? { email: env.ABOUT_EMAIL } : {}),
					...(env.ABOUT_GITHUB ? { github: env.ABOUT_GITHUB } : {}),
				}
			: undefined;

	const apiKey = env.DEEPSEEK_API_KEY?.trim();

	const config: AppConfig = {
		allowedEmails: csv(env.ALLOWED_EMAILS),
		passkeys: rpId && origin ? { rpId, origin, rpName: env.PASSKEY_RP_NAME?.trim() || "Cuota" } : null,
		invoiceReader: apiKey ? { apiKey, ...(env.DEEPSEEK_MODEL ? { model: env.DEEPSEEK_MODEL } : {}) } : null,
		version: env.APP_VERSION?.trim() || "0.0.0-dev",
		...(about ? { about } : {}),
	};

	return {
		port: portOf(env.PORT),
		databaseUrl: env.DATABASE_URL?.trim() || "file:./data/cuota.db",
		config,
	};
}