# Contributing

## Requirements

Node.js 24 or newer. `npm ci` installs the exact locked toolchain.

## Before you open a pull request

```sh
npm run ci
```

That runs the typecheck, the build, and the test suite. CI runs the same
command on Node 24, so a green local run is the expected baseline.

## Branches and commits

Branch names carry a type prefix: `feat/`, `fix/`, `chore/`, `docs/`,
`refactor/`. Commit subjects use the same prefixes in the imperative mood, for
example `fix: keep the leftover cent on the lower id`.

## Tests

- Tests run in plain Node and must not need the network.
- The default run uses SQLite in memory. Set `TEST_DATABASE_URL` to run the
  same suite against PostgreSQL; that path needs a reachable server and is what
  CI's PostgreSQL job does.
- A new database adapter must pass `test/contract/sql-database.contract.ts`.
- Never commit real financial data, real email addresses, credentials, or
  deployment identifiers. Fixtures use names such as `example.com` and round
  amounts.
- Anything that depends on a particular host or database belongs in the
  consuming repository as an adapter, with a contract test here.

## Scope

This package stays runtime-neutral. A change that makes `src/` depend on a
host, a deployment tool, or a Node built-in needs to be an adapter outside this
package instead.