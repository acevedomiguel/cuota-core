/**
 * cuota-core
 *
 * Runtime-neutral core for a two-person shared expense app: expenses split in
 * proportion to each person's income as it stood when the expense was recorded.
 *
 * This file is the scaffold entry point. The runtime-neutral application
 * factory and its ports (database, configuration, assets) land in the
 * extraction step; nothing in `src/` may import Cloudflare Workers types,
 * Node built-ins, or any specific deployment runtime.
 *
 * `lib: ["DOM"]` in tsconfig is here only for Web Standards globals such as
 * `fetch`, `Request`, `Response`, `crypto`, and `btoa`. It is not permission to
 * touch `window` or `document`: this package has no browser UI.
 */
export {};