# Troubleshooting

Start with the narrowest relevant check:

```powershell
bun run check
bun run db:check
$env:LIVE_TEST_ENABLED="true"
bun run test:live
```

The live test uses the configured PostgreSQL and Redis services, starts the compiled server on an isolated port, verifies CLI/SDK behavior, and removes its uniquely identified records.

## Server does not start

### Required configuration is missing

Messages such as `DATABASE_URL must be configured` mean `apps/server/.env` is absent, loaded from the wrong workspace, or incomplete. Start through a root script such as `bun run dev` or run within `apps/server` so Bun loads the intended `.env`.

### Admin API key is rejected at startup

Every primary or rotation admin key must be at least 32 characters and must not begin with a known placeholder such as `replace`, `change`, `example`, or `development`. Generate a random secret and update the CLI configuration to match.

### Typed setting is invalid

Boolean settings accept exactly `true` or `false`. Integer ranges are documented in [configuration](configuration.md). Values such as `yes`, `3000.0`, or a port above 65535 stop startup.

### Migrations folder was not found

Deploy the complete `apps/server/dist/` folder, including `drizzle/`. If migrations live elsewhere, set `DRIZZLE_MIGRATIONS_PATH` to that directory.

### PostgreSQL or Redis connection fails

- Confirm the URL, credentials, TLS requirements, DNS, and firewall rules.
- Remember that `localhost` inside a container refers to that container.
- Run the provider's native connectivity check from the same network as Keyzori.
- Check `/ready`; it returns `503` if either dependency is unavailable.

The server applies migrations and connects to Redis before listening, so dependency failures normally prevent startup.

### Port is already in use

Choose another `PORT` or stop the conflicting process. The compiled `--healthcheck` mode uses the same configured port.

## Health and readiness

| Symptom | Interpretation |
| --- | --- |
| `/health` returns `200`, `/ready` returns `503` | Process is alive, but PostgreSQL or Redis is unavailable. |
| Both routes fail | Process is stopped, unreachable, bound incorrectly, or blocked by networking. |
| `/ready` is healthy but license routes return `429` | Dependencies work; the client exceeded its rate limit. |

Do not send production traffic based only on `/health`.

## CLI failures

### `DATABASE_URL must be configured`

Run `keyzori-admin` inside the configured server container, or provide the same PostgreSQL URL used by the server runtime.

### Database connection failure

Confirm that `DATABASE_URL` is reachable from the CLI process and that PostgreSQL is accepting connections. The CLI does not require Redis or the HTTP server.

### Key creation fails validation

Check the rules in [licensing model](licensing-model.md): `USAGE` needs a positive balance, `SUBSCRIPTION` needs a future expiry, and other types reject `expiresAt`.

### A created secret is lost

Full secrets are returned once and then hashed. They cannot be recovered from `list-keys` or PostgreSQL. Create a replacement license, distribute it securely, and revoke the old record.

## SDK failures

### Initial `License Block` error

The server rejected policy. The message identifies the first failing rule. Confirm secret, revocation, expiry, whitelist, trial, usage, concurrency, IP, and HWID settings.

### `Maximum concurrent sessions reached`

Ensure previous application instances call `destroy()`. After a crash, wait at least 45 seconds from the last successful heartbeat for Redis expiry. Session tokens are issued and managed by the SDK.

### `IP registration threshold exceeded` or `Hardware registration threshold exceeded`

The license has already registered its configured number of distinct values. Network-adapter, VM, hostname, CPU topology, or proxy changes may affect the observed identity. Review the license limits and trusted-proxy configuration.

### `network:offline`

Consecutive retryable heartbeat failures reached `maxRetries`. Check server readiness, network path, TLS, rate limits, and `requestTimeoutMs`. A new `LicenseClient` is required after fatal destruction.

### `heartbeat:throttled`

The server returned `429`. The SDK honors `Retry-After`, reschedules, and does not add a failure strike. Check `LICENSE_RATE_LIMIT_PER_MINUTE`, the coarse IP ceiling, and whether an application is creating unnecessary clients.

### Runtime policy event selection

Updated servers return stable error codes. Invalid/revoked keys emit `license:revoked`; trial/subscription expiry emits `license:expired`; an invalid session emits `session:expired`; other whitelist, concurrency, usage, IP, or HWID failures emit `license:rejected`. The SDK keeps legacy message classification for older servers.

### HWID changes unexpectedly

Without an explicit `hardwareId`, the SDK's legacy HWID reflects OS, architecture, logical CPU count, MAC addresses, and sometimes hostname. Containers, VM cloning, adapter replacement, privacy MAC rotation, and host changes can produce a new value. Supply a stable application-specific `hardwareId` when the host signal is unsuitable; only its SHA-256 digest is sent.

## Migration and data issues

- Run `bun run db:check` before release.
- Back up PostgreSQL before applying new migrations.
- Do not use `db:push` against production.
- License secrets have a non-null SHA-256 `keyHash` and display `keyPrefix`; no plaintext key column remains.
- The non-negative limit migration deliberately stops when negative legacy values exist. Repair those rows explicitly before rerunning it; the migration never silently clamps them.

If a migration fails, stop the rollout and restore or repair according to a reviewed database plan. Do not edit migration history after it has been applied to shared environments.

## Reporting a problem

Use the repository issue template and include the Keyzori version, Bun version, operating system, component, deployment method, reproduction, and sanitized logs. Never include license secrets, admin keys, database URLs, customer data, or hardware identifiers. Report vulnerabilities privately according to [SECURITY.md](../SECURITY.md).
