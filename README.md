# cuota-core

A runtime-neutral core for a shared-expense app built for two people.

Each shared expense is split in proportion to the two people's incomes as they
stood when the expense was recorded. A later raise or pay cut changes how the
next expense is split; it never re-splits history.

This package is the reusable half of a private deployment of the same app. The
host supplies a database driver, a config, and a static asset handler, so the
same build runs in a container against SQLite or PostgreSQL, or on a
serverless runtime, without forking it.

## Usage

```ts
import { createCuotaApp } from "cuota-core";

const app = createCuotaApp({
	database, // SqlDatabase: prepare/bind/first/all/run, exec, now
	config: {
		allowedEmails: ["one@example.com", "two@example.com"],
		passkeys: { rpId: "localhost", origin: "http://localhost", rpName: "Cuota" },
		version: "1.0.0",
	},
	assets, // AssetHandler: serves /static/*
});
```

The result is a Hono app: `app.request(request)` in a test, `app.fetch` on a
serverless runtime, `serve(app.fetch)` behind a Node server.

## Status

The application is extracted: `createCuotaApp` builds the whole app from its
three ports, and `adapters/` holds host drivers (SQLite through Node's built-in
driver, a static file handler). PostgreSQL persistence and a Node server
entry are next.

## Requirements

Node.js 24 or newer (see `.nvmrc`).

## Development

```sh
npm ci
npm run ci      # typecheck, build, test
npm test
npm run build
```

`npm run build` compiles the EJS views to plain functions and then the
TypeScript to `dist/`. The compiled views are committed because a serverless
runtime forbids `new Function`.

## Layout

```text
src/         runtime-neutral core: domain logic, routes, views, the factory
adapters/    host drivers: SQLite, static files
migrations/  SQLite schema
test/        unit and integration tests, plain Node, no network
```

Adapters for a specific database or host belong here or in the consuming
repository; the core never imports them.

## Ports

- `SqlDatabase` — `prepare()` with `bind/first/all/run`, `exec()` for
  migrations, and `now()` for the database clock. Inserts that need the new id
  end in `RETURNING id`.
- `AssetHandler` — `fetch(request)` serving `/static/*`.
- `AppConfig` — allowlist, passkey relying party, optional invoice reading,
  version, and the optional about-page contact block.

## Design rules

- `src/` imports no Node built-ins, no host-specific types, and no deployment
  tooling. Web Standards globals (`fetch`, `crypto`, `btoa`) are the only
  platform surface; the DOM lib is enabled for those globals only.
- Money is integer minor units. Timestamps are millisecond ISO text, ordered
  lexicographically, so string comparison is chronological comparison.
- A split is frozen when the expense is recorded. History is never recomputed
  from a later income change.
- Tests must not require the network or real personal data.

## License

MIT. See [LICENSE](LICENSE).