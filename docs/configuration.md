# Configuration

Keyzori reads only `KEYZORI_`-prefixed runtime variables. Copy `.env.example`, replace placeholder secrets, and keep the file out of source control.

## Required services and admin access

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `KEYZORI_DATABASE_URL` | Yes | — | PostgreSQL URL using `postgres:` or `postgresql:`. |
| `KEYZORI_REDIS_URL` | Yes | — | Redis URL using `redis:` or `rediss:`. |
| `KEYZORI_ADMIN_API_KEY` | Yes | — | Primary `X-Admin-Key`; at least 32 non-placeholder characters. |
| `KEYZORI_ADMIN_API_KEYS` | No | Empty | Comma-separated previous/secondary admin keys for rotation. |
| `KEYZORI_SERVER_HOST` | No | `0.0.0.0` | Bind host. |
| `KEYZORI_SERVER_PORT` | No | `3000` | Bind port. |

The admin API key is not a dashboard credential and is never exposed to the browser.

## Embedded operator dashboard

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `KEYZORI_DISABLE_DASHBOARD` | No | `false` | When `true`, dashboard routes/assets are absent while the API remains available. |
| `KEYZORI_DASHBOARD_USERNAME` | When enabled | — | Operator login name, up to 128 characters. |
| `KEYZORI_DASHBOARD_PASSWORD` | When enabled | — | Separate non-placeholder password of at least 16 characters. |
| `KEYZORI_DASHBOARD_SECURE_COOKIES` | No | `true` | Uses a Secure `__Host-` session cookie. Set `false` only for local HTTP. |
| `KEYZORI_DASHBOARD_SESSION_TTL_MINUTES` | No | `480` | Redis-backed session lifetime, 5–1440 minutes. |
| `KEYZORI_EVENT_RETENTION_DAYS` | No | `30` | Detailed activity retention, 1–365 days. Lifetime totals remain. |

Dashboard sessions and login throttling live in Redis. The dashboard uses the server host and port. Put production deployments behind TLS and keep secure cookies enabled.

## Optional Stripe synchronization

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `KEYZORI_STRIPE_SECRET_KEY` | Together | Disabled | Stripe server secret used only by the operator integration. |
| `KEYZORI_STRIPE_WEBHOOK_SECRET` | Together | Disabled | Signing secret for the Keyzori webhook endpoint. |

Both absent disables Stripe routes, processing, and dashboard controls. Supplying only one fails startup clearly. Configure Stripe to deliver subscription and invoice lifecycle events to `/webhooks/stripe` after the integration is enabled.

## HTTP and abuse controls

| Variable | Default | Accepted values |
| --- | --- | --- |
| `KEYZORI_OPENAPI_ENABLED` | `true` | `true` or `false` |
| `KEYZORI_RATE_LIMIT_PER_MINUTE` | `60` | Admin per-IP budget, 1–100000 |
| `KEYZORI_LICENSE_RATE_LIMIT_PER_MINUTE` | `30` | Runtime principal budget per endpoint, 1–100000; usage cannot exhaust heartbeat/deactivation capacity |
| `KEYZORI_RATE_LIMIT_PER_IP_PER_MINUTE` | `6000` | Coarse runtime IP ceiling, 1–1000000 |
| `KEYZORI_MAX_REQUEST_BODY_BYTES` | `65536` | Request body limit, 1024–10485760 |

## Trusted proxies

Proxy headers are ignored by default.

| Variable | Default | Purpose |
| --- | --- | --- |
| `KEYZORI_TRUST_PROXY_HEADERS` | `false` | Enables trusted client-IP headers. |
| `KEYZORI_TRUSTED_PROXY_HEADER` | `x-forwarded-for` | `x-forwarded-for`, `cf-connecting-ip`, `x-real-ip`, or `*` to reconcile all present headers. |
| `KEYZORI_TRUSTED_PROXY_CIDRS` | Empty | Required when trust is enabled; comma-separated immediate-proxy CIDRs. |

Use `*` for the CIDR value only when a firewall makes direct access impossible. Otherwise list the exact reverse-proxy networks so clients cannot spoof IP-based limits or login throttling.

## Migration location

`KEYZORI_DRIZZLE_MIGRATIONS_PATH` overrides migration discovery. The compiled image normally finds its embedded `drizzle` directory automatically; use the override only for a deliberate external migration bundle.
