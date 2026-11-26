import type { AppConfig } from "./config.js";
import type { Session, SqlDatabase } from "./ports.js";

export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** A stored credential, in the shape @simplewebauthn/server expects. */
export interface PasskeyCredential {
	id: string;
	userId: number;
	publicKey: string;
	credentialType: "public-key";
	deviceType: "singleDevice" | "multiDevice";
	backedUp: boolean;
	aaguid: string;
	name: string;
	transports: string[];
	counter: number;
	createdAt: string;
	lastUsedAt: string | null;
}

interface PasskeyRow {
	id: string;
	user_id: number;
	credential_public_key: string;
	credential_type: "public-key";
	device_type: "singleDevice" | "multiDevice";
	backed_up: number;
	aaguid: string;
	name: string;
	transports: string;
	counter: number;
	created_at: string;
	last_used_at: string | null;
}

function mapPasskey(row: PasskeyRow): PasskeyCredential {
	let transports: string[] = [];
	try {
		const parsed: unknown = JSON.parse(row.transports);
		if (Array.isArray(parsed)) transports = parsed.filter((t): t is string => typeof t === "string");
	} catch {
		// a malformed transports column must not break sign-in
	}
	return {
		id: row.id,
		userId: row.user_id,
		publicKey: row.credential_public_key,
		credentialType: row.credential_type,
		deviceType: row.device_type,
		backedUp: row.backed_up === 1,
		aaguid: row.aaguid,
		name: row.name,
		transports,
		counter: row.counter,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at,
	};
}

export async function savePasskeyCredential(
	db: SqlDatabase,
	credential: PasskeyCredential,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO passkey_credentials (
				id, user_id, credential_public_key, credential_type, device_type,
				backed_up, aaguid, name, transports, counter, created_at, last_used_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			credential.id,
			credential.userId,
			credential.publicKey,
			credential.credentialType,
			credential.deviceType,
			credential.backedUp ? 1 : 0,
			credential.aaguid,
			credential.name,
			JSON.stringify(credential.transports),
			credential.counter,
			credential.createdAt,
			credential.lastUsedAt,
		)
		.run();
}

export async function listPasskeysByUser(db: SqlDatabase, userId: number): Promise<PasskeyCredential[]> {
	const { results } = await db
		.prepare("SELECT * FROM passkey_credentials WHERE user_id = ? ORDER BY created_at, id")
		.bind(userId)
		.all<PasskeyRow>();
	return results.map(mapPasskey);
}

/** Looks a credential up by its WebAuthn id, regardless of owner. */
export async function getPasskeyById(db: SqlDatabase, id: string): Promise<PasskeyCredential | null> {
	const row = await db
		.prepare("SELECT * FROM passkey_credentials WHERE id = ?")
		.bind(id)
		.first<PasskeyRow>();
	return row ? mapPasskey(row) : null;
}

/**
 * Deletes a credential only when the row belongs to `userId`, returning whether
 * a row was actually removed. Ownership is part of the WHERE clause rather than
 * a read-then-write, so a request can never delete someone else's passkey.
 */
export async function deletePasskey(db: SqlDatabase, id: string, userId: number): Promise<boolean> {
	const result = await db
		.prepare("DELETE FROM passkey_credentials WHERE id = ? AND user_id = ?")
		.bind(id, userId)
		.run();
	return Number(result.meta.changes) > 0;
}

/** Advances the signature counter; a replay (non-advancing) counter throws. */
export async function updatePasskeyCounter(
	db: SqlDatabase,
	id: string,
	counter: number,
	lastUsedAt: string,
): Promise<void> {
	const result = await db
		.prepare("UPDATE passkey_credentials SET counter = ?, last_used_at = ? WHERE id = ? AND counter <= ?")
		.bind(counter, lastUsedAt, id, counter)
		.run();
	if (Number(result.meta.changes) === 0) throw new Error("Passkey counter did not advance");
}

export type PasskeyChallengeKind = "registration" | "authentication";

function challengeKeys(kind: PasskeyChallengeKind) {
	const prefix = kind === "registration" ? "passkeyRegistration" : "passkeyAuthentication";
	return {
		challenge: `${prefix}Challenge`,
		expiresAt: `${prefix}ChallengeExpiresAt`,
		userVerification: `${prefix}UserVerification`,
	} as const;
}

/** Puts a fresh 32-byte challenge in the session; the ceremony must consume it. */
export function issuePasskeyChallenge(
	session: Session,
	kind: PasskeyChallengeKind,
	now = Date.now(),
): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const challenge = encodeBase64Url(bytes);
	const keys = challengeKeys(kind);
	session.set(keys.challenge, challenge);
	session.set(keys.expiresAt, now + PASSKEY_CHALLENGE_TTL_MS);
	session.set(keys.userVerification, "required");
	return challenge;
}

function decodeBase64UrlBytes(encoded: string): Uint8Array<ArrayBuffer> {
	const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

export function decodeBase64Url(encoded: string): Uint8Array<ArrayBuffer> {
	return decodeBase64UrlBytes(encoded);
}

/** Same decoding, named for the challenge's use in generate*Options. */
export function decodePasskeyChallenge(challenge: string): Uint8Array<ArrayBuffer> {
	return decodeBase64UrlBytes(challenge);
}

export function encodeBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Single use: reads and clears the challenge, returning null if stale/absent. */
export function consumePasskeyChallenge(
	session: Session,
	kind: PasskeyChallengeKind,
	now = Date.now(),
): { challenge: string; userVerification: "required" } | null {
	const keys = challengeKeys(kind);
	const challenge = session.get<string>(keys.challenge);
	const expiresAt = session.get<number>(keys.expiresAt);
	const userVerification = session.get<string>(keys.userVerification);
	session.set(keys.challenge, undefined);
	session.set(keys.expiresAt, undefined);
	session.set(keys.userVerification, undefined);

	if (
		typeof challenge !== "string" ||
		typeof expiresAt !== "number" ||
		now > expiresAt ||
		userVerification !== "required"
	) {
		return null;
	}
	return { challenge, userVerification: "required" };
}

/**
 * rpID + origin for the WebAuthn ceremony. Throws when they are unset or
 * inconsistent, so a misconfigured deploy fails loudly instead of registering
 * credentials that can never be used.
 */
export function passkeyConfig(config: AppConfig): { rpID: string; origin: string } {
	if (!config.passkeys) {
		throw new Error("passkeys are not configured (config.passkeys is null)");
	}
	const { rpId: rpID, origin } = config.passkeys;
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		throw new Error("config.passkeys.origin must be an exact origin (scheme://host[:port])");
	}
	if (url.origin !== origin) {
		throw new Error("config.passkeys.origin must be an exact origin (scheme://host[:port])");
	}
	if (url.protocol === "https:" && (rpID === "localhost" || rpID.includes(":") || rpID.includes("/"))) {
		throw new Error("config.passkeys.rpId must be the production domain name");
	}
	// WebAuthn only accepts an rpID that is the origin's host or a registrable
	// suffix of it; catching the mismatch here beats a browser-side failure.
	if (url.hostname !== rpID && !url.hostname.endsWith(`.${rpID}`)) {
		throw new Error(`config.passkeys.rpId (${rpID}) is not a suffix of the origin (${url.hostname})`);
	}
	return { rpID, origin };
}
