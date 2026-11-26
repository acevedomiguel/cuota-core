import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { AssetHandler } from "../src/ports.js";

const CONTENT_TYPES: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};

/**
 * Serves a directory as `/static/*`. This is the container/test adapter; a
 * serverless host passes its own binding instead.
 */
export function fileAssets(directory: string): AssetHandler {
	const root = resolve(directory);

	return {
		async fetch(request: Request): Promise<Response> {
			if (request.method !== "GET" && request.method !== "HEAD") {
				return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
			}

			const path = decodeURIComponent(new URL(request.url).pathname);
			const file = resolve(root + sep + path.replace(/^\/+/, ""));

			if (file !== root && !file.startsWith(root + sep)) {
				return new Response("Not found", { status: 404 });
			}

			try {
				const body = await readFile(file);
				return new Response(request.method === "HEAD" ? null : body, {
					headers: { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" },
				});
			} catch {
				return new Response("Not found", { status: 404 });
			}
		},
	};
}