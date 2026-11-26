/**
 * Everything a deployment decides. The app reads this through the request
 * context, never from a global environment object, so the same build runs
 * anywhere.
 */

export interface PasskeyConfig {
	/** WebAuthn relying-party id: the origin's host, exactly. */
	rpId: string;
	/** The origin users sign in from, `scheme://host[:port]`, exactly. */
	origin: string;
	/** Name the browser shows in its passkey prompt. */
	rpName: string;
}

/** Optional invoice-photo reading. Absent means the feature is off. */
export interface InvoiceReaderConfig {
	apiKey: string;
	/** Model override; the reader has its own default. */
	model?: string;
}

/** Optional contact block on the about page. */
export interface AboutConfig {
	builtBy?: string;
	email?: string;
	github?: string;
	/**
	 * What is actually running, for a host that can tell: a deployment id, tag,
	 * or timestamp. Omitted by hosts that cannot.
	 */
	deployed?: { label: string; at: string };
}

export interface AppConfig {
	/** Emails allowed to sign up. Compared case-insensitively and trimmed. */
	allowedEmails: readonly string[];
	/** Passkeys are unavailable while this is null. */
	passkeys: PasskeyConfig | null;
	/** Invoice photo reading is off while this is null or absent. */
	invoiceReader?: InvoiceReaderConfig | null;
	/** Release version shown on the about page. */
	version: string;
	/**
	 * When set, the first-run setup page also requires this token, so an
	 * unclaimed public deployment cannot be taken over by the first stranger
	 * who finds it. Omit it and setup is open only while the database is empty.
	 */
	setupToken?: string;
	/** Contact details shown on the about page; omit both to hide the block. */
	about?: AboutConfig;
}