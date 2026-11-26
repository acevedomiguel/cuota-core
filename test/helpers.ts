import { env, SELF } from "./harness.js";
import { testMigrations } from "./dialect.js";
import { applyMigrations } from "../src/migrations.js";

const ORIGIN = "http://example.com";

/**
 * Applies the schema for the running dialect. Safe to call more than once:
 * the migration runner records what it has already applied.
 */
export async function initDb(): Promise<void> {
	await applyMigrations(env.DB, await testMigrations());
}

export interface FormSession {
	/** The `cuota_session` cookie jar entry, kept current across requests. */
	cookie: string;
	csrf: string;
}

function cookiesOf(res: Response): string {
	return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

function csrfOf(html: string): string {
	const csrf = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
	if (!csrf) throw new Error("no csrf token in that response");
	return csrf;
}

/**
 * Fetches with the session's cookie, then folds any refreshed cookie back into
 * the jar: the challenge for a WebAuthn ceremony lives in the signed cookie,
 * so (as in a browser) each response's Set-Cookie must accompany the next call.
 */
async function withJar(session: FormSession, path: string, init: RequestInit): Promise<Response> {
	const res = await SELF.fetch(`${ORIGIN}${path}`, {
		...init,
		headers: { ...(init.headers ?? {}), cookie: session.cookie },
		redirect: "manual",
	});
	const refreshed = cookiesOf(res);
	if (refreshed) session.cookie = refreshed;
	return res;
}

/** GETs a page to obtain the session cookie and the hidden CSRF token. */
export async function startSession(path: string): Promise<FormSession> {
	const res = await SELF.fetch(`${ORIGIN}${path}`, { redirect: "manual" });
	const session: FormSession = { cookie: cookiesOf(res), csrf: "" };
	session.csrf = csrfOf(await res.text());
	return session;
}

/** GETs a page in an existing session and returns the HTML. */
export async function getPage(session: FormSession, path: string): Promise<string> {
	return await (await withJar(session, path, {})).text();
}

/** Re-reads the CSRF token from a page (tokens rotate on login). */
export async function refreshCsrf(session: FormSession, path: string): Promise<void> {
	session.csrf = csrfOf(await getPage(session, path));
}

/** POSTs URL-encoded form fields (plus `_csrf`) with the session cookie. */
export async function postForm(
	path: string,
	fields: Record<string, string>,
	session?: FormSession,
): Promise<Response> {
	const current = session ?? (await startSession(path));
	const body = new URLSearchParams({ _csrf: current.csrf, ...fields });
	return withJar(current, path, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body,
	});
}

/** POSTs a JSON body (plus `_csrf`) with the session cookie. */
export async function postJson(
	path: string,
	body: Record<string, unknown>,
	session: FormSession,
): Promise<Response> {
	return withJar(session, path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ...body, _csrf: session.csrf }),
	});
}

/** POSTs a multipart body (e.g. a file upload) with the session cookie. */
export async function postMultipart(path: string, form: FormData, session: FormSession): Promise<Response> {
	return withJar(session, path, { method: "POST", body: form });
}

/**
 * Signs up (allowlist permitting) and logs in, then re-reads the home page for
 * the CSRF token rotated by `establishAuthenticatedSession`. Idempotent: a
 * second call for the same email just signs in again.
 */
export async function signUpAndLogIn(
	email: string,
	password = "twelve-chars-ok",
	name = "Test Person",
): Promise<FormSession> {
	const signup = await postForm("/signup", { email, name, password });
	if (signup.status !== 303 && signup.status !== 400) {
		throw new Error(`signup failed: ${signup.status}`);
	}
	const session = await startSession("/login");
	const login = await postForm("/login", { email, password }, session);
	if (login.status !== 303) throw new Error(`login failed: ${login.status}`);
	await refreshCsrf(session, "/");
	return session;
}