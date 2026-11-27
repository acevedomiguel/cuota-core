// Serving a stored receipt. The image is never public: only an authenticated
// member of the household can read it, and nothing is cached by a proxy.

import { Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import { getReceipt, receiptCutoff, retentionEnabled } from "../receipts.js";

const app = new Hono<AppEnv>();

app.get("/expenses/:id/photo", async (c) => {
	const user = c.get("user");
	if (!user) return c.redirect("/login", 303);

	const store = c.get("receipts");
	if (!store) return c.notFound();

	const expenseId = Number(c.req.param("id"));
	if (!Number.isInteger(expenseId) || expenseId <= 0) return c.notFound();

	const receipt = await getReceipt(c.get("db"), expenseId);
	if (!receipt) return c.notFound();

	// Past the retention window the photo is not served either, even if its row
	// is still waiting for the sweep: a retained photo is not a readable one.
	const days = c.get("receiptRetentionDays");
	if (retentionEnabled(days)) {
		const cutoff = receiptCutoff(days, new Date(await c.get("db").now()));
		if (receipt.created_at < cutoff) return c.notFound();
	}

	const object = await store.get(receipt.object_key);
	if (!object) return c.notFound();

	// Copy into a fresh buffer: the port hands back a plain Uint8Array, and a
	// Response body wants an ArrayBuffer-backed one.
	const bytes = new Uint8Array(object.body);

	return new Response(bytes.buffer, {
		headers: {
			"content-type": object.contentType,
			"content-length": String(bytes.length),
			// A receipt is private: no shared cache may keep a copy.
			"cache-control": "private, no-store",
		},
	});
});

export default app;
