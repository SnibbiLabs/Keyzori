# Keyzori server

The server workspace contains the HTTP API, optional embedded operator dashboard, application services, PostgreSQL/Redis adapters, migrations, local admin CLI, Stripe synchronization, and unified Docker build.

## Run

From the repository root:

```powershell
Copy-Item .env.example .env
bun run setup
bun run dev
```

The API serves `/health`, `/ready`, and `/docs` on `KEYZORI_SERVER_PORT`. Unless disabled, the same listener serves `/` and `/dashboard/*`.

## Runtime API

| Route | Input identity | Purpose |
| --- | --- | --- |
| `POST /v1/activate` | `licenseKey`, `deviceId` | Validate policy and issue a bound session. |
| `POST /v1/heartbeat` | `sessionToken`, `deviceId` | Recheck current policy and refresh TTL. |
| `POST /v1/usage` | Session plus meter event | Atomically consume named-meter units. |
| `POST /v1/deactivate` | `sessionToken`, `deviceId` | Release a session immediately. |

Only activation receives the full secret. See the [runtime flow](../../docs/runtime-flow.md) and [API reference](../../docs/api-reference.md).

## Operator surfaces

- The embedded dashboard uses separate credentials, Redis sessions/login throttling, CSRF and same-origin enforcement, scoped security headers, and authenticated SSE.
- `/admin/customers` and `/admin/licenses` use `X-Admin-Key` and expose explicit management actions for status, access, sessions, rotation, meters, and optional Stripe linking.
- `keyzori admin ...` calls the same application services directly against PostgreSQL.

Licensed product users have no Keyzori account or access to any operator surface.

## Build

```powershell
bun run build:server
bun run server
bun run cli:binary -- --help
```

The output directory contains one platform-specific `keyzori` executable, migrations, and legal notices. Commands are `keyzori serve`, `keyzori admin ...`, and `keyzori healthcheck`.

## Database changes

```powershell
bun run db:generate
bun run db:check
bun run db:migrate
```

Review generated SQL and snapshots. Use `db:push` only for disposable development databases. Back up production PostgreSQL before applying the data-preserving vocabulary and licensing migration.

## Container

```powershell
bun run docker:build
docker run --env-file .env -p 3000:3000 keyzori-license-server
```

The final pinned distroless image is non-root and contains no Bun installation, `node_modules`, separate dashboard process, or second CLI executable. Set `KEYZORI_DISABLE_DASHBOARD=true` to run API-only. See [configuration](../../docs/configuration.md) and [deployment](../../docs/deployment.md).
