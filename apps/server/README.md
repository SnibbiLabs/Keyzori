<div align="center">

# Keyzori server

**The deployable Keyzori licensing runtime.**

[`Project`](../../README.md) · [`HTTP API`](../../docs/api-reference.md) · [`Configuration`](../../docs/configuration.md) · [`Deployment`](../../docs/deployment.md)

<br />

<code>Elysia</code> <code>Drizzle</code> <code>PostgreSQL</code> <code>Redis</code>

</div>

---

The server runtime owns HTTP and CLI delivery, application use cases, Drizzle persistence, Redis-backed sessions, database migrations, and the standalone Docker image.

## Run locally

From the repository root:

```powershell
Copy-Item apps/server/.env.example apps/server/.env
bun run db:migrate
bun run dev
```

Pending migrations are also applied automatically when the production server starts.

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Process liveness without dependency checks |
| `GET /ready` | PostgreSQL and Redis readiness |
| `GET /docs` | Interactive Scalar API reference |
| `GET /docs/openapi.json` | Generated OpenAPI document |

## Configuration

<details>
<summary><strong>Core environment variables</strong></summary>

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | — | PostgreSQL connection URL |
| `REDIS_URL` | — | Redis connection URL |
| `ADMIN_API_KEY` | — | Secret required in `X-Admin-Key` for `/admin/*` |
| `ADMIN_API_KEYS` | empty | Previous keys accepted during credential rotation |
| `HOST` | `0.0.0.0` | Server bind address |
| `PORT` | `3000` | HTTP port |
| `TRUST_PROXY_HEADERS` | `false` | Trust forwarded IP headers behind a restricted proxy |
| `TRUSTED_PROXY_HEADER` | `x-forwarded-for` | Select X-Forwarded-For chain or explicit Cloudflare mode |
| `TRUSTED_PROXY_CIDRS` | empty | Immediate proxy networks allowed to provide forwarded IPs |
| `OPENAPI_ENABLED` | `true` | Expose Scalar and the OpenAPI document |
| `RATE_LIMIT_PER_MINUTE` | `60` | Per-IP administrator request budget |
| `LICENSE_RATE_LIMIT_PER_MINUTE` | `30` | Per-principal runtime request budget |
| `RATE_LIMIT_PER_IP_PER_MINUTE` | `6000` | Coarse per-IP abuse ceiling |
| `MAX_REQUEST_BODY_BYTES` | `65536` | Request body ceiling |
| `DRIZZLE_MIGRATIONS_PATH` | bundled path | Optional migration-folder override |

</details>

See the [configuration reference](../../docs/configuration.md) for validation ranges, proxy behavior, and credential rotation.

## HTTP surface

| Method and route | Purpose | Authentication |
| --- | --- | --- |
| `GET /health` | Liveness | None |
| `GET /ready` | Dependency readiness | None |
| `POST /v1/handshake` | Validate a license and refresh its session | License key in body |
| `POST /v1/logout` | Release an active session | License key in body |
| `POST /admin/users` | Create a license owner | `X-Admin-Key` |
| `GET /admin/users` | List license owners | `X-Admin-Key` |
| `POST /admin/keys` | Create a key | `X-Admin-Key` |
| `GET /admin/keys` | List keys | `X-Admin-Key` |
| `PATCH /admin/keys/:id` | Revoke a key | `X-Admin-Key` |

The dark monochrome Scalar reference is generated from the same Elysia schemas that validate requests. Set `OPENAPI_ENABLED=false` when documentation must not be publicly exposed.

## License rules

<table>
<tr>
<td width="50%" valign="top">

**Limits**

- `limitIp`, `limitHwid`, and `limitConcurrent` use `0` for unlimited and accept at most `2147483647`.
- `USAGE` keys consume one unit when a new session starts.
- Heartbeats for an existing session consume no additional units.
- Explicit IP/HWID whitelists run before dynamic registration limits.

</td>
<td width="50%" valign="top">

**Time and sessions**

- `SUBSCRIPTION` keys require a future `expiresAt`.
- `trialDurationMin` starts on the first successful handshake.
- Sessions expire after 45 seconds without a successful heartbeat, and successful handshakes advertise that TTL to SDKs.
- Logout releases a session immediately and is idempotent.

</td>
</tr>
</table>

See the [handshake flow](../../docs/handshake-flow.md) for the exact validation order.

License traffic is limited by a hashed API-key/HWID or session-token principal (30/minute by default) plus a 6,000/minute coarse IP ceiling. Admin routes retain their separate 60/minute IP budget. Every error response includes a stable `code` and `429` responses include `Retry-After`.

## Build and deploy

### Runtime administration CLI

The CLI is bundled with the server and calls `AdminService` directly through the same PostgreSQL repositories as the HTTP delivery adapter. It requires `DATABASE_URL`, but does not require the HTTP server, Redis, or `ADMIN_API_KEY`.

```powershell
bun run cli -- list-users
docker exec keyzori-license-server keyzori-admin list-users
```

See the [CLI reference](../../docs/cli-reference.md) for all commands.

### Standalone executable

```powershell
bun run build:server
bun run server
```

The deployable output is `apps/server/dist/`: `keyzori-server`, `keyzori-admin`, and the `drizzle/` migrations. Bun and `node_modules` are required to build them, not to run them.

### Docker

```powershell
docker build --file apps/server/Dockerfile --tag keyzori-license-server .
docker run --env-file apps/server/.env -p 3000:3000 keyzori-license-server
```

PostgreSQL and Redis must be provisioned separately and reachable from the container.

## Database workflow

The schema lives in [`src/db/schema.ts`](src/db/schema.ts), Drizzle Kit configuration in [`drizzle.config.ts`](drizzle.config.ts), and committed SQL under [`drizzle/`](drizzle/).

```powershell
bun run db:generate # after editing schema.ts
bun run db:check    # validate migration history
bun run db:migrate  # apply committed migrations
bun run db:push     # local prototyping only
bun run db:studio
```

> [!NOTE]
> The first Drizzle migration recognizes the existing Prisma-era schema, preserving tables and data while registering migration history.

For complete payloads, responses, examples, and errors, use the [HTTP API reference](../../docs/api-reference.md).
