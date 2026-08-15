# Troubleshooting

Start with focused verification:

```powershell
bun run typecheck
bun run test
bun run db:check
$env:KEYZORI_LIVE_TEST_ENABLED="true"
bun run test:live
```

## Startup

### Dashboard credentials are required

The dashboard is enabled by default. Configure a separate `KEYZORI_DASHBOARD_USERNAME` and password of at least 16 characters, or set `KEYZORI_DISABLE_DASHBOARD=true`. The password cannot equal an admin API key.

For loopback HTTP development, set `KEYZORI_DASHBOARD_SECURE_COOKIES=false`. Keep it `true` behind production TLS.

### Stripe configuration is partial

Set both `KEYZORI_STRIPE_SECRET_KEY` and `KEYZORI_STRIPE_WEBHOOK_SECRET`, or remove both. Keyzori intentionally refuses partial configuration instead of exposing a webhook or controls that cannot reconcile safely.

### PostgreSQL or Redis is unavailable

- Verify URL, credentials, TLS requirements, DNS, and firewall rules.
- Remember that `localhost` inside a container refers to that container.
- Check `/ready`; it returns `503` when either dependency fails.
- Confirm the committed `drizzle` directory is beside the compiled executable.

### Forwarded IPs are wrong

Leave proxy trust disabled unless requests can arrive only through known proxies. When enabled, list the immediate proxy networks in `KEYZORI_TRUSTED_PROXY_CIDRS`; an incorrect value affects IP limits and dashboard login throttling.

## Dashboard

### Login loops or the cookie is missing

Secure cookies require HTTPS. Check proxy scheme/host forwarding, Redis connectivity, browser cookie policy, and the configured session TTL. Dashboard sessions are intentionally independent of `KEYZORI_ADMIN_API_KEY`.

### Live events stop

Confirm the reverse proxy permits `text/event-stream`, disables response buffering, and allows long-lived requests to `/dashboard/api/events`. The browser reconnects automatically and refreshes recent durable activity after reconnection.

### The root route returns 404

This is expected when `KEYZORI_DISABLE_DASHBOARD=true`. No dashboard assets, login, session, JSON, or SSE routes are mounted in that mode.

## Licenses and SDK

### Activation is rejected

Use the stable error code:

- `LICENSE_INVALID`, `LICENSE_REVOKED`, or `LICENSE_EXPIRED`: inspect secret and effective status.
- `IP_NOT_ALLOWED` or `DEVICE_NOT_ALLOWED`: inspect explicit allowlists.
- `IP_REGISTRATION_LIMIT` or `DEVICE_REGISTRATION_LIMIT`: release a registered slot or raise the corresponding limit.
- `CONCURRENT_SESSION_LIMIT`: terminate sessions or wait for the advertised TTL.

Type and policy changes apply on the next activation or heartbeat.

### Session expires unexpectedly

Heartbeat, usage, and deactivation must use the server-issued token from activation and the same bound IP/device context. A revoke, secret rotation, explicit session termination, Redis loss, or missed TTL invalidates it. Activate again after resolving the cause.

### Usage fails

- `METER_NOT_FOUND`: verify the immutable meter name.
- `METER_ARCHIVED`: create/use another active meter.
- `METER_EXHAUSTED`: top up or adjust the balance with an operator reason.
- `USAGE_EVENT_CONFLICT`: the same `eventId` was reused with different meter or units. Generate an ID for each logical event and keep it unchanged only for retries.

Activation and heartbeat never debit a meter.

### A full secret was lost

Full secrets cannot be recovered from a hash. Rotate the license, securely provision the new one-time `licenseKey`, and let Keyzori terminate existing sessions.

## Stripe

### Signature verification fails

Confirm the endpoint uses its own `whsec_...` signing secret, the proxy does not transform the body, and Stripe targets `/webhooks/stripe`. Never disable signature verification.

### Access does not match a recent event

Request synchronization from the operator dashboard. Keyzori retrieves current subscription state, so duplicate or out-of-order webhook delivery is not resolved by manually replaying event payloads.

Manual revocation always wins. Payment recovery clears only a Stripe-originated revocation.

## Migrations

Back up PostgreSQL before release, run `bun run db:check`, and never use `db:push` in production. The vocabulary migration preserves legacy secrets and data, converts prior usage balance into a default `usage` meter, and converts legacy mixed trials into the standalone trial policy with their remaining duration.

If migration validation stops on invalid legacy values, repair those rows deliberately and rerun. Do not edit migration history after shared deployment.
