import { Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import type { SqlDatabase } from "../ports.js";
import { renderView } from "../views.js";

const app = new Hono<AppEnv>();

/**
 * Static /about page: what the app is in one line, the release version the
 * deployment is running, and the optional contact block from its config.
 */
app.get("/about", (c) => {
	const user = c.get("user");
	if (!user) throw new Error("GET /about reached without a gate-verified user");
	const config = c.get("config");

	return c.html(
		renderView("about", {
			title: "About",
			authenticated: true,
			csrfToken: c.get("csrfToken"),
			user: { name: user.name, email: user.email },
			version: config.version,
			about: config.about ?? {},
		}),
	);
});

export default app;
