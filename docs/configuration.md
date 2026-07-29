# Configuration reference

Keyzori uses Bun's native `.env` loading. Do not add `dotenv`. The HTTP server and CLI are both owned by `apps/server` and use `apps/server/.env` during source development.

## Server variables

| Variable | Required | Default | Accepted values | Purpose |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | Yes | — | PostgreSQL URL | Drizzle connection and runtime migrations. |
| `REDIS_URL` | Yes | — | Redis URL | Concurrent-session state and request rate limiting. |
| `ADMIN_API_KEY` | Yes | — | Random secret, at least 32 characters | Primary credential accepted by `/admin/*`. Known placeholder prefixes are rejected. |
| `ADMIN_API_KEYS` | No | Empty | Comma-separated secrets, each at least 32 characters | Additional credentials used during zero-downtime rotation. |
| `HOST` | No | `0.0.0.0` | Bind hostname or address | Network interface used by the HTTP server. |
| `PORT` | No | `3000` | Integer `1`–`65535` | HTTP listen port and compiled health-check target. |
| `TRUST_PROXY_HEADERS` | No | `false` | `true` or `false` | Enables trusted proxy IP headers. Never enable for directly reachable servers. |
| `TRUSTED_PROXY_HEADER` | No | `x-forwarded-for` | `x-forwarded-for` or `cf-connecting-ip` | Selects the only forwarded-address mechanism Keyzori will read. |
| `TRUSTED_PROXY_CIDRS` | When proxy trust is enabled | — | Comma-separated IPv4/IPv6 CIDRs | Immediate proxy networks allowed to supply forwarded client IPs. |
| `OPENAPI_ENABLED` | No | `true` | `true` or `false` | Exposes `/docs` and `/docs/openapi.json` when enabled. |
| `RATE_LIMIT_PER_MINUTE` | No | `60` | Integer `1`–`100000` | Per-source-IP administrator budget. |
| `LICENSE_RATE_LIMIT_PER_MINUTE` | No | `30` | Integer `1`–`100000` | Runtime budget per hashed license/HWID principal or hashed session token. |
| `RATE_LIMIT_PER_IP_PER_MINUTE` | No | `6000` | Integer `1`–`1000000` | Coarse source-IP abuse ceiling in addition to route-specific budgets. |
| `MAX_REQUEST_BODY_BYTES` | No | `65536` | Integer `1024`–`10485760` | Maximum request body accepted by Bun. |
| `DRIZZLE_MIGRATIONS_PATH` | No | Auto-discovered | Directory path | Overrides the committed migration directory. |

The server exits before listening when required values are missing, typed settings are invalid, the admin secret is weak, migrations fail, or Redis cannot connect.

### Proxy IP behavior

With `TRUST_PROXY_HEADERS=false`, Keyzori uses the TCP peer address and ignores forwarded headers. With it enabled, the TCP peer must first match `TRUSTED_PROXY_CIDRS`. In the default `x-forwarded-for` mode, Keyzori validates at most 32 entries and walks the chain right-to-left through trusted proxy CIDRs; malformed or excessive chains fall back to the peer. `CF-Connecting-IP` is read only when `TRUSTED_PROXY_HEADER=cf-connecting-ip`.

Only enable proxy trust when direct access to Keyzori is blocked and your proxy removes untrusted inbound forwarding headers.

### Admin credential rotation

1. Generate a new random value with at least 32 characters.
2. Set the new value as `ADMIN_API_KEY`.
3. Put the previous value in `ADMIN_API_KEYS` and deploy.
4. Update the dashboard and every direct admin API client. The CLI does not use this credential.
5. Remove the previous value from `ADMIN_API_KEYS` and deploy again.

Every value in `ADMIN_API_KEYS` must meet the same validation rules as the primary key.

## Dashboard variables

The standalone dashboard uses its own environment and never connects directly to PostgreSQL or Redis.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `KEYZORI_SERVER_URL` | Yes | — | Keyzori server origin. HTTPS is required outside loopback unless the private-network override is enabled. |
| `KEYZORI_AUTH_PASS` | Yes | — | Dashboard login password with at least 16 characters. It must differ from the admin API key. |
| `KEYZORI_ADMIN_KEY` | Yes | — | Server `ADMIN_API_KEY` used only by the dashboard's server-side API proxy. |
| `HOST` | No | `0.0.0.0` | Dashboard bind address. |
| `PORT` | No | `3100` | Dashboard listen port. |
| `KEYZORI_SECURE_COOKIES` | No | `true` | Secure-cookie and HSTS policy. Disable only for loopback HTTP development. |
| `KEYZORI_SESSION_TTL_MINUTES` | No | `480` | Fixed in-memory session lifetime from 5 to 1440 minutes. |
| `KEYZORI_UPSTREAM_TIMEOUT_MS` | No | `10000` | Upstream API timeout from 1000 to 60000 milliseconds. |
| `KEYZORI_ALLOW_INSECURE_SERVER` | No | `false` | Allows an HTTP server URL outside loopback for a trusted private network. |

See the [dashboard guide](../apps/dash/README.md) for its complete security model and standalone run commands.

## CLI configuration

CLI commands use `DATABASE_URL` from the server runtime. They do not use `SERVER_URL`, Redis, or an admin API credential. Help and version work without database configuration.

## Example server configuration

```dotenv
HOST=0.0.0.0
PORT=3000
DATABASE_URL=postgresql://keyzori:password@postgres.internal:5432/keyzori
REDIS_URL=redis://redis.internal:6379
ADMIN_API_KEY=replace_with_a_generated_secret_of_32_or_more_characters
TRUST_PROXY_HEADERS=false
TRUSTED_PROXY_HEADER=x-forwarded-for
# TRUSTED_PROXY_CIDRS=10.0.0.0/8
OPENAPI_ENABLED=false
RATE_LIMIT_PER_MINUTE=60
LICENSE_RATE_LIMIT_PER_MINUTE=30
RATE_LIMIT_PER_IP_PER_MINUTE=6000
MAX_REQUEST_BODY_BYTES=65536
```

The placeholder shown above is intentionally rejected. Replace it before starting the server.
