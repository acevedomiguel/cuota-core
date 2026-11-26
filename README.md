# cuota-core

A runtime-neutral core for a shared-expense app built for two people.

Each shared expense is split in proportion to the two people's incomes as they
stood when the expense was recorded. A later raise or pay cut changes how the
next expense is split; it never re-splits history.

This package is the reusable half of a private deployment of the same app. The
deployment side (hosting, database driver, secrets) lives in the consuming
repository, so the same core can run in a container against PostgreSQL or on a
serverless runtime without forking it.

## Status

Scaffold. The runtime-neutral application factory and its ports land in the
extraction step, so the package currently exports nothing. Nothing here is
stable yet.

## Requirements

Node.js 24 or newer (see `.nvmrc`).

## Development

```sh
npm ci
npm run ci      # typecheck, build, test
npm test
npm run build
```

## Planned layout

```text
src/     runtime-neutral domain logic and the application factory
test/    unit and contract tests, plain Node, no network
```

Adapters for a specific database or host belong in the consuming repository,
not here.

## Design rules

- `src/` imports no Node built-ins, no host-specific types, and no deployment
  tooling. Web Standards globals (`fetch`, `crypto`, `btoa`) are the only
  platform surface.
- Money is integer minor units. Timestamps are millisecond ISO text, ordered
  lexicographically, so string comparison is chronological comparison.
- A split is frozen when the expense is recorded. History is never recomputed
  from a later income change.
- Tests must not require the network or real personal data.

## License

MIT. See [LICENSE](LICENSE).