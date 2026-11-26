import { Hono } from "hono";
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { AppEnv } from "../app-env.js";
import { establishAuthenticatedSession } from "../auth.js";
import {
	consumePasskeyChallenge,
	decodeBase64Url,
	decodePasskeyChallenge,
	encodeBase64Url,
	getPasskeyById,
	listPasskeysByUser,
	updatePasskeyCounter,
	issuePasskeyChallenge,
	passkeyConfig,
	savePasskeyCredential,
} from "../passkeys.js";

const CHALLENGE_TIMEOUT_MS = 5 * 60 * 1000;
const SUPPORTED_ALGORITHMS = [-7, -257];

const app = new Hono<AppEnv>();

app.post("/passkeys/register/options", async (c) => {
	// `user` is set by the auth gate after verifying the session row —
	// never trust the cookie's userId on its own.
	const user = c.get("user");
	if (!user) return c.json({ error: "Sign in first." }, 401);
	const userId = user.id;

	const { rpID } = passkeyConfig(c.get("config"));
	const challenge = issuePasskeyChallenge(c.get("session"), "registration");
	return c.json(
		await generateRegistrationOptions({
			rpName: c.get("config").passkeys?.rpName ?? "Cuota",
			rpID,
			userID: Uint8Array.from(new TextEncoder().encode(user.email)),
			userName: user.email,
			userDisplayName: user.name || user.email,
			challenge: decodePasskeyChallenge(challenge),
			timeout: CHALLENGE_TIMEOUT_MS,
			attestationType: "none",
			excludeCredentials: (await listPasskeysByUser(c.get("db"), userId)).map((credential) => ({
				id: credential.id,
				transports: credential.transports,
			})),
			authenticatorSelection: {
				residentKey: "required",
				requireResidentKey: true,
				userVerification: "required",
				authenticatorAttachment: "platform",
			},
			supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
		}),
	);
});

app.post("/passkeys/register/verify", async (c) => {
	const user = c.get("user");
	if (!user) return c.json({ error: "Sign in first." }, 401);
	const userId = user.id;

	const expected = consumePasskeyChallenge(c.get("session"), "registration");
	if (!expected) return c.json({ error: "Passkey registration expired. Try again." }, 400);
	const credential = ((await c.req.json().catch(() => undefined)) as { credential?: RegistrationResponseJSON } | undefined)
		?.credential;
	if (!credential) return c.json({ error: "Passkey registration failed. Try again." }, 400);

	try {
		const { rpID, origin } = passkeyConfig(c.get("config"));
		const verification = await verifyRegistrationResponse({
			response: credential,
			expectedChallenge: expected.challenge,
			expectedOrigin: origin,
			expectedRPID: rpID,
			requireUserPresence: true,
			requireUserVerification: true,
			supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
		});
		if (!verification.verified || !verification.registrationInfo) {
			return c.json({ error: "Passkey registration failed. Try again." }, 400);
		}

		const info = verification.registrationInfo;
		const existing = await listPasskeysByUser(c.get("db"), userId);
		await savePasskeyCredential(c.get("db"), {
			id: info.credential.id,
			userId,
			publicKey: encodeBase64Url(info.credential.publicKey),
			credentialType: "public-key",
			deviceType: info.credentialDeviceType,
			backedUp: info.credentialBackedUp,
			aaguid: info.aaguid,
			name: existing.length ? `Passkey ${existing.length + 1}` : "Passkey",
			transports: (info.credential.transports ?? []) as string[],
			counter: info.credential.counter,
			createdAt: new Date().toISOString(),
			lastUsedAt: null,
		});
		return c.json({ verified: true });
	} catch (error) {
		console.warn("Passkey registration verification failed", error);
		return c.json({ error: "Passkey registration failed. Try again." }, 400);
	}
});

app.post("/login/passkey/options", async (c) => {
	const { rpID } = passkeyConfig(c.get("config"));
	const challenge = issuePasskeyChallenge(c.get("session"), "authentication");
	return c.json(
		await generateAuthenticationOptions({
			rpID,
			allowCredentials: [],
			challenge: decodePasskeyChallenge(challenge),
			timeout: CHALLENGE_TIMEOUT_MS,
			userVerification: "required",
		}),
	);
});

app.post("/login/passkey/verify", async (c) => {
	const expected = consumePasskeyChallenge(c.get("session"), "authentication");
	if (!expected) return c.json({ error: "Passkey sign-in expired. Try again." }, 400);
	const credential = ((await c.req.json().catch(() => undefined)) as { credential?: AuthenticationResponseJSON } | undefined)
		?.credential;
	if (!credential?.id) return c.json({ error: "Passkey sign-in failed. Try again." }, 400);

	const stored = await getPasskeyById(c.get("db"), credential.id);
	if (!stored) return c.json({ error: "This passkey is not registered with cuota." }, 404);

	try {
		const { rpID, origin } = passkeyConfig(c.get("config"));
		const verification = await verifyAuthenticationResponse({
			response: credential,
			expectedChallenge: expected.challenge,
			expectedOrigin: origin,
			expectedRPID: rpID,
			credential: {
				id: stored.id,
				publicKey: decodeBase64Url(stored.publicKey),
				counter: stored.counter,
				transports: stored.transports,
			},
			requireUserVerification: true,
		});
		if (!verification.verified) {
			return c.json({ error: "Passkey sign-in failed. Try again." }, 401);
		}

		await updatePasskeyCounter(
			c.get("db"),
			stored.id,
			verification.authenticationInfo.newCounter,
			new Date().toISOString(),
		);
		// The session row belongs to the credential's owner, not to whoever
		// started the ceremony: a passkey is proof of that user's identity.
		await establishAuthenticatedSession(c.get("db"), c.get("session"), stored.userId);
		return c.json({ verified: true });
	} catch (error) {
		console.warn("Passkey authentication verification failed", error);
		return c.json({ error: "Passkey sign-in failed. Try again." }, 401);
	}
});

export default app;
