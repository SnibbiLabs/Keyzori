# Deployment

## Docker Compose

Copy the example environment, generate independent random secrets, then start the stack:

```powershell
Copy-Item .env.example .env
docker compose --file dev.docker-compose.yml up --build -d
docker compose --file dev.docker-compose.yml exec server keyzori admin --help
```

Set `KEYZORI_POSTGRES_PASSWORD` and `KEYZORI_ADMIN_API_KEY` in `.env` before starting. Development Compose builds locally and binds Keyzori to `127.0.0.1:3000`. PostgreSQL and Redis stay on the private network; the application runs as non-root with a read-only filesystem, drops all Linux capabilities, and enables `no-new-privileges`.

For production, use the published stable image and put a TLS reverse proxy in front of port `3000`:

```powershell
docker compose --file prod.docker-compose.yml pull
docker compose --file prod.docker-compose.yml up -d
```

The in-container CLI uses the same PostgreSQL and Redis configuration:

```powershell
docker compose --file dev.docker-compose.yml exec server keyzori admin customers list
docker compose --file dev.docker-compose.yml exec server keyzori admin licenses list
```

## Standalone container

Build and run the hardened server image without Compose:

```powershell
bun run docker:build
docker run --name keyzori `
  --env-file .env `
  --publish 127.0.0.1:3000:3000 `
  --read-only `
  --tmpfs /tmp:rw,noexec,nosuid,size=16m `
  --cap-drop ALL `
  --security-opt no-new-privileges:true `
  keyzori-license-server
```

Invoke `keyzori admin ...` through `docker exec`. The image entrypoint also accepts `serve` and `healthcheck` directly. Ensure `KEYZORI_DATABASE_URL` and `KEYZORI_REDIS_URL` refer to services reachable from inside the container rather than container-local `localhost`.

## External PostgreSQL and Redis

The server image needs only these reachable dependencies:

```text
KEYZORI_DATABASE_URL=postgresql://...
KEYZORI_REDIS_URL=rediss://...
```

Use encrypted connections where the providers support them, restrict network access to the Keyzori workload, and back up PostgreSQL. Redis holds replaceable runtime sessions and rate-limit state, but production Redis should still use authentication, persistence appropriate to your recovery target, and eviction monitoring.

## Reverse proxy

Preserve the original host and scheme. Trust forwarded client IPs only when direct server access is blocked and `KEYZORI_TRUSTED_PROXY_CIDRS` lists the immediate proxy networks.

Route the chosen hostname to port `3000`. The listener serves `/v1/*`, `/admin/*`, `/webhooks/stripe`, `/health`, `/ready`, and `/docs`. Use access controls around the operator routes as appropriate for the deployment.

## Stripe

Set both Stripe variables or neither. After deployment, create a Stripe webhook endpoint for:

```text
https://licenses.example.com/webhooks/stripe
```

Subscribe to customer subscription and invoice lifecycle events. Keyzori verifies the untouched request body, stores event IDs for deduplication, processes asynchronously, and retrieves current subscription state before changing access. It never cancels or modifies the Stripe subscription.

## Health and startup

- `/health` proves the HTTP process is alive.
- `/ready` returns success only when PostgreSQL and Redis respond.
- container health runs `keyzori healthcheck` against `/ready`.
- `keyzori serve` applies committed migrations before listening.

Use rolling deployment rules that do not send traffic until readiness succeeds. A type change, revoke, or rotation takes effect on the next runtime request; revoked or rotated licenses also have active sessions terminated.

## Image contents

The multi-stage build uses version-tagged Bun and distroless base images, a frozen lockfile, and a BuildKit dependency cache. The final image contains only:

- the single compiled `keyzori` executable;
- committed SQL migrations;
- `LICENSE` and `NOTICE`.

Every release publishes `ghcr.io/snibbilabs/keyzori:v<version>`. Stable releases also update `ghcr.io/snibbilabs/keyzori:latest`; prereleases do not.

### Publish a version

Set the same numeric SemVer version in the root, server, and SDK `package.json` files, then commit it to `main`. The Git tag adds the required `v` prefix:

```powershell
$releaseTag = "v1.1.0"
git tag -a $releaseTag -m $releaseTag
git push origin main
git push origin $releaseTag
```

Pushing the tag starts the Release workflow. It rejects tags that do not exactly match the package version or whose commit is not on `main`. The workflow creates a GitHub Release with automatically generated notes from the commits and merged pull requests since the previous release; it does not create new commits. A stable tag such as `v1.1.0` publishes `:v1.1.0` and moves `:latest`; a prerelease such as `v1.1.0-rc.1` publishes only its exact version tag.

To republish or repair an existing tag, open **Actions → Release → Run workflow** and enter the existing `v`-prefixed tag. The tag must already exist in the repository.

CI and release builds compare the image against the published dual-binary `v0.2.1-test.2` baseline and fail unless the unified image is at least 35% smaller. Every run reports both sizes and the reduction in the workflow summary.

## Native binary

`bun run build:server` creates `apps/server/dist/keyzori` (or `keyzori.exe` on Windows), committed migrations, and legal notices. Deploy the entire `dist` directory on the same operating system and CPU architecture used for the build, then run `keyzori serve`.
