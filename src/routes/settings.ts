import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import { hashPassword, passwordLongEnough, verifyPassword } from "../auth.js";
import { updatePasswordHash } from "../db.js";
import { deletePasskey, getPasskeyById, listPasskeysByUser } from "../passkeys.js";
import { renderView } from "../views.js";

const MIN_PASSWORD_MESSAGE = "Password must be at least 12 characters.";
const WRONG_PASSWORD_MESSAGE = "Current password is wrong";

const app = new Hono<AppEnv>();

interface SettingsNotice {
	notice?: string;
	error?: string;
}

/** /settings markup for the signed-in user, with only their own passkeys. */
async function renderSettingsHtml(c: Context<AppEnv>, extra: SettingsNotice = {}): Promise<string> {
	const user = c.get("user");
	if (!user) throw new Error("renderSettingsHtml called without a gate-verified user");

	const passkeys = (await listPasskeysByUser(c.get("db"), user.id)).map((passkey) => ({
		id: passkey.id,
		name: passkey.name,
		created: passkey.createdAt.slice(0, 10),
		lastUsed: passkey.lastUsedAt ? passkey.lastUsedAt.slice(0, 10) : null,
	}));

	return renderView("settings", {
		title: "Settings",
		authenticated: true,
		csrfToken: c.get("csrfToken"),
		user: { name: user.name, email: user.email },
		passkeys,
		...extra,
	});
}

/** Renders /settings, redirecting a signed-out request to the gate's login page. */
async function renderSettings(c: Context<AppEnv>, extra: SettingsNotice = {}) {
	if (!c.get("user")) return c.redirect("/login", 303);
	return c.html(await renderSettingsHtml(c, extra));
}

app.get("/settings", (c) => renderSettings(c));

app.post("/settings/passkeys/:id/delete", async (c) => {
	const user = c.get("user");
	if (!user) return c.redirect("/login", 303);

	const id = c.req.param("id");
	const existing = await getPasskeyById(c.get("db"), id);
	// 404, not 403: the id exists but belongs to someone else, and a 403 would
	// confirm to the other partner that the credential is real. An id that
	// exists for nobody is an idempotent no-op, so re-clicking Delete on an
	// already-deleted passkey does not surface an error.
	if (existing && existing.userId !== user.id) {
		return c.html(renderView("error", { title: "Passkey not found", authenticated: true }), 404);
	}

	await deletePasskey(c.get("db"), id, user.id);
	return c.redirect("/settings", 303);
});

app.post("/settings/password", async (c) => {
	const user = c.get("user");
	if (!user) return c.redirect("/login", 303);

	const body = await c.req.parseBody();
	const current = String(body.current ?? "");
	const next = String(body.next ?? "");

	// A live session is not proof of identity: a borrowed laptop must not be
	// enough to lock the owner out of their own account.
	if (!(await verifyPassword(current, user.password_hash))) {
		return c.html(await renderSettingsHtml(c, { error: WRONG_PASSWORD_MESSAGE }), 422);
	}
	if (!passwordLongEnough(next)) {
		return c.html(await renderSettingsHtml(c, { error: MIN_PASSWORD_MESSAGE }), 422);
	}

	await updatePasswordHash(c.get("db"), user.id, await hashPassword(next));
	// The session row and cookie are untouched on purpose: changing a password
	// re-authenticates, it does not end the session that made the change.
	return c.redirect("/settings", 303);
});

export default app;
