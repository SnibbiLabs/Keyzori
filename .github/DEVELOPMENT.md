# Developing Keyzori

```powershell
Copy-Item .env.example .env
bun run setup
bun run dev
```

The root `.env` configures the server, embedded operator dashboard, PostgreSQL, and Redis.

## Root development commands

```powershell
bun run dev                 # API and optional dashboard watch mode
bun run dev:server          # equivalent focused server command
bun run dev:server:binary   # rebuild and run the standalone executable
bun run cli:help            # CLI usage
bun run cli -- customers list # invoke a CLI command
bun run test:server         # focused server tests
bun run test:cli            # focused CLI tests
bun run test:sdk            # focused SDK tests
bun run test:flow           # cross-app in-memory flow
```

Turborepo executes each task inside its owning app and caches successful build and type-check results.

## Repository layout

```text
apps/
  server/   HTTP API, optional dashboard, CLI, migrations, and unified image
  sdk/      publishable application integration SDK
docs/       cross-application architecture and operations guides
tests/      cross-application product-flow tests
```

## Schema changes

1. Edit `apps/server/src/db/schema.ts`.
2. Run `bun run db:generate`.
3. Review and commit the generated SQL and snapshot under `apps/server/drizzle/`.
4. Run `bun run db:migrate` against a development database.

Use `db:push` only for disposable local prototyping.

## Verification

```powershell
bun run check
bun run build
bun run docker:build
```

`bun run test` includes a cross-app product-flow test using in-memory adapters. The opt-in test below covers the real PostgreSQL and Redis adapters and is intentionally excluded from the default suite.

With disposable/test PostgreSQL and Redis URLs configured in the root `.env`, run the opt-in live lifecycle test with:

```powershell
$env:KEYZORI_LIVE_TEST_ENABLED="true"
bun run test:live
```

It starts the compiled server on an isolated port, exercises CLI administration and SDK session behavior, then removes only its uniquely identified database and Redis records.

`bun run build:server` creates one platform-specific `keyzori` executable plus migrations under `apps/server/dist/`. Use `keyzori serve`, `keyzori admin ...`, or `keyzori healthcheck`. The Docker build copies only these runtime artifacts into the final image; `KEYZORI_DISABLE_DASHBOARD=true` prevents dashboard routes from being mounted.

Keep domain and application code independent of Drizzle, Redis, Elysia, and Commander. External-system implementations belong in infrastructure or delivery code.
