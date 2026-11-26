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
serverless runtime, or `serve(app.fetch)` behind a Node server.

## Running it

Node, with a SQLite file:

```sh
npm ci
npm run build:server
DATABASE_URL=file:./data/cuota.db ALLOWED_EMAILS=you@example.com npm start
# http://localhost:3000, health at /healthz
```

Migrations are applied at startup, before the server listens, and rerunning is
a no-op.

Docker, with its own PostgreSQL:

```sh
cp .env.example .env         # set ALLOWED_EMAILS at minimum
docker compose --profile bundled up --build
```

Docker, against a database you already run: put `postgres://…` in
`DATABASE_URL` in `.env`, then

```sh
docker compose --profile external up --build
```

The image runs as the unprivileged `node` user and defaults to SQLite at
`file:./data/cuota.db`, so it also works with no database service at all. Every
variable is documented in `.env.example`.

### Smoke test

`npm run smoke` drives a running instance over HTTP: signup, login, salary,
expense, dashboard, analytics, settings, logout.

```sh
BASE_URL=http://127.0.0.1:3000 SMOKE_EMAIL=you@example.com npm run smoke
```

### Password recovery

With no email sending, the owner resets a password from the host:

```sh
npm run reset-password -- you@example.com
```

It reads the password from stdin, never from an argument, so it cannot land in
shell history or a process list. Pipe it in non-interactively:

```sh
printf 'a-long-new-password' | npm run reset-password -- you@example.com
```

## Status

The application is extracted behind ports, PostgreSQL persistence is in place,
and the Node server and Docker image run both database modes. A first-run setup
wizard is the next piece: today the first account still needs `ALLOWED_EMAILS`.

## Requirements

Node.js 24 or newer (see `.nvmrc`).

## Development

```sh
npm ci
npm run ci      # typecheck, package build, server build, test
npm test
npm run build
```

`npm run build` compiles the EJS views to plain functions and then the
TypeScript package to `dist/`. The compiled views are committed because a
serverless runtime forbids `new Function`. `npm run build:server` compiles the
container entry and adapters to `build/`.

## Layout

```text
src/         runtime-neutral core: domain logic, routes, views, the factory
adapters/    host drivers: SQLite, PostgreSQL, static files, migrations
server/      container entry, environment loading, password recovery
migrations/  SQLite schema; migrations/postgres/ mirrors it
test/        unit and integration tests, plain Node, no network
```

## Databases

Two adapters ship here:

- `adapters/sqlite.ts` — Node's built-in `node:sqlite`, in memory or a file.
- `adapters/postgres.ts` — `node-postgres`, with optional schema isolation.

Migrations are plain SQL: `migrations/` for SQLite, `migrations/postgres/` for
PostgreSQL. `applyMigrations(db, migrations)` from the package records each
version in `schema_migrations` and is safe to rerun; `adapters/migration-files.ts`
reads a directory into the list it expects.

The test suite runs against either database. PostgreSQL tests are skipped when
`TEST_DATABASE_URL` is unset, so the default run needs nothing installed:

```sh
docker run -d --name cuota-pg \
  -e POSTGRES_USER=cuota -e POSTGRES_PASSWORD=cuota -e POSTGRES_DB=cuota_test \
  -p 55432:5432 postgres:17-alpine

TEST_DATABASE_URL=postgres://cuota:cuota@localhost:55432/cuota_test npm test
```

## Ports

- `SqlDatabase` — `prepare()` with `bind/first/all/run`, `exec()` for
  migrations, and `now()` for the database clock. Inserts that need the new id
  end in `RETURNING id`.
- `AssetHandler` — `fetch(request)` serving `/static/*`.
- `AppConfig` — allowlist, passkey relying party, optional invoice reading,
  version, and the optional about-page contact block.

`createCuotaApp` also takes an `extend` hook, mounted before the auth gate, for
host routes such as `/healthz`.

## Design rules

- `src/` imports no Node built-ins, no host-specific types, and no deployment
  tooling. Web Standards globals (`fetch`, `crypto`, `btoa`) are the only
  platform surface; the DOM lib is enabled for those globals only.
- Money is integer minor units. Timestamps are millisecond ISO text, ordered
  lexicographically, so string comparison is chronological comparison.
- A split is frozen when the expense is recorded. History is never recomputed
  from a later income change.
- Tests must not require the network or real personal data, and must pass on
  both database engines.

## License

MIT. See [LICENSE](LICENSE).