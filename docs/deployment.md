# Deploying Keyzori

For local evaluation, the repository's Docker Compose stack starts the server, PostgreSQL, and Redis together. In production, provision PostgreSQL and Redis separately and deploy the standalone server container.

## Local stack

```powershell
$env:ADMIN_API_KEY=(New-Guid).Guid + (New-Guid).Guid
$env:POSTGRES_PASSWORD=((New-Guid).Guid + (New-Guid).Guid).Replace("-", "")
docker compose up --build
docker compose exec server keyzori-admin list-users
```

Compose fails closed when either secret is unset, persists PostgreSQL in the `postgres-data` volume, runs the application container with reduced privileges, and publishes the local server only on `127.0.0.1:3000`. Keep `POSTGRES_PASSWORD` URL-safe because Compose embeds it in `DATABASE_URL`.

The second command runs the bundled CLI inside the server container with its existing `DATABASE_URL`.

## Build

```powershell
bun run docker:build
```

The image is named `keyzori-license-server`. Its runtime stage contains the compiled server and admin CLI executables, required system libraries, committed Drizzle SQL migrations, and the repository license and notice. Bun and `node_modules` stay in the discarded build stage.

## Run

Provide these required variables:

The admin secret must contain at least 32 characters and must be generated randomly. Optional settings are documented in `apps/server/.env.example`, including request limits, proxy handling, documentation exposure, bind address, and maximum request size.

See the [configuration reference](configuration.md) for every server and CLI setting.

To rotate the admin credential without downtime, deploy the new value as `ADMIN_API_KEY` and temporarily place the previous value in the comma-separated `ADMIN_API_KEYS` setting. Update all administrators, then remove the previous value and redeploy.

- `DATABASE_URL` — reachable PostgreSQL URL
- `REDIS_URL` — reachable Redis URL
- `ADMIN_API_KEY` — long unique administrator secret

```powershell
docker run --name keyzori-license-server `
  --env-file apps/server/.env `
  --publish 3000:3000 `
  keyzori-license-server
```

Administer the running deployment from its container terminal:

```powershell
docker exec keyzori-license-server keyzori-admin list-users
docker exec keyzori-license-server keyzori-admin create-user --email owner@example.com --name "Owner"
```

The CLI inherits `DATABASE_URL` from the container and connects directly to PostgreSQL. It does not require the HTTP process to be healthy and does not use `ADMIN_API_KEY`.

The container applies pending migrations before accepting traffic. The image health check calls `/ready`.

Use `/health` as a liveness probe and `/ready` as a readiness probe. The readiness endpoint verifies PostgreSQL and Redis connectivity and returns HTTP 503 when either dependency is unavailable.

For local services running on Docker Desktop’s host, use `host.docker.internal` rather than `localhost` in database and Redis URLs. In production, use private network service addresses.

## Standalone dashboard

The optional dashboard is deployed separately from the server and performs every data operation through the authenticated admin HTTP API. It does not need database or Redis access.

```powershell
Copy-Item apps/dash/.env.example apps/dash/.env
# Configure KEYZORI_SERVER_URL, KEYZORI_AUTH_PASS, and KEYZORI_ADMIN_KEY.
bun install --frozen-lockfile
bun run dash
```

For a container deployment:

```powershell
docker build --file apps/dash/Dockerfile --tag keyzori-dashboard .
docker run --env-file apps/dash/.env --publish 3100:3100 keyzori-dashboard
```

Terminate TLS in front of the dashboard, keep secure cookies enabled, and restrict network access to operators. The browser receives only an opaque session cookie; `KEYZORI_ADMIN_KEY` remains in the dashboard process. A restart clears all in-memory dashboard sessions.

## Secure deployment guidance

- Terminate TLS at a trusted reverse proxy or platform load balancer.
- Keep PostgreSQL and Redis off the public internet.
- Back up PostgreSQL before deploying schema changes.
- Set `TRUST_PROXY_HEADERS=true` only when direct access is blocked, set `TRUSTED_PROXY_CIDRS` to every trusted hop, and choose `TRUSTED_PROXY_HEADER`. Use `cf-connecting-ip` only behind Cloudflare.
- Restrict `/admin/*` at the network layer when possible.
- Store newly created license secrets immediately; the server hashes them at rest and cannot display them again.
- Before shipping an SDK update, run `bun run test:sdk:compiled`; CI and release workflows execute the same downstream Bun executable gate on Ubuntu.
- Pull the published server image as `ghcr.io/lilsnibbi/keyzori:<commit-sha>` for an immutable build, or use its release tag (for example, `v1.0.0`). Pin production deployments to a commit-SHA tag or digest.
- Send `SIGTERM` during deployments and allow in-flight requests to finish before enforcing a kill timeout.
- Monitor `/ready`, HTTP error rates, rate-limit responses, PostgreSQL, Redis, and process restarts.

## Non-container deployment

Build on the same operating system and CPU architecture as the destination:

```powershell
bun run build:server
```

Deploy the generated `apps/server/dist/` folder, which contains both executables, the migrations, and the required license and notice. The destination does not need Bun or `node_modules`. Run `keyzori-server` as the service and invoke `keyzori-admin` for local administration. Set `DRIZZLE_MIGRATIONS_PATH` only if migrations are moved away from the server executable.

Startup applies pending migrations automatically.
