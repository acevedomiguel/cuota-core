import type { AppConfig } from "./config.js";
import type { UserRow } from "./db.js";
import type { AssetHandler, ReceiptStore, Session, SqlDatabase } from "./ports.js";

/**
 * What every handler can read from its context. The host's dependencies are
 * set once, by `createCuotaApp`, before any route runs.
 */
export interface AppEnv {
	Variables: {
		db: SqlDatabase;
		config: AppConfig;
		assets: AssetHandler;
		/** Absent when the host stores no receipts. */
		receipts?: ReceiptStore;
		session: Session;
		csrfToken: string;
		/** Set by the auth gate after verifying the session row. */
		user: UserRow | null;
	};
}