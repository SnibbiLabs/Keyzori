# HTTP API reference

Keyzori exposes system, licensed-product runtime, and instance-operator routes. Interactive Scalar documentation is available at `/docs`, with its OpenAPI document at `/docs/openapi.json`, when `KEYZORI_OPENAPI_ENABLED=true`.

The optional dashboard at `/` is exclusively for developers operating the Keyzori instance. It is not a customer portal, and licensed-product users do not receive dashboard accounts, license secrets, or access to administrative APIs.

## Conventions

- JSON requests use `Content-Type: application/json`.
- Every `/admin/*` request requires `X-Admin-Key`.
- Only `/v1/activate` accepts a `licenseKey`. The other runtime routes use the server-issued `sessionToken` and the same `deviceId`.
- Timestamps are ISO 8601 strings.
- Limits are integers from `0` to `2147483647`; `0` means unlimited for `maxIps`, `maxDevices`, and `maxSessions`.
- Errors use `{ "error": "message", "code": "STABLE_CODE" }`.
- Rate-limit responses use HTTP `429`, include `Retry-After`, and return code `RATE_LIMITED`. Runtime budgets are isolated per endpoint, so usage traffic cannot consume heartbeat or deactivation capacity.
- API responses are non-cacheable and include restrictive security headers.

## End-to-end example

This example creates a customer and lifetime license, activates it, refreshes the session, and deactivates it. Store the one-time `licenseKey` securely and avoid placing production secrets in shell history.

```bash
# Create a customer and copy its id.
curl --fail-with-body https://licenses.example.com/admin/customers \
  -H "X-Admin-Key: $KEYZORI_ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"email":"customer@example.com","name":"Example Customer"}'

# Create a license and copy the one-time licenseKey.
curl --fail-with-body https://licenses.example.com/admin/licenses \
  -H "X-Admin-Key: $KEYZORI_ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"customerId":"CUSTOMER_ID","type":"lifetime","maxDevices":1,"maxSessions":1}'

# Activate and copy sessionToken.
curl --fail-with-body https://licenses.example.com/v1/activate \
  -H "Content-Type: application/json" \
  --data '{"licenseKey":"lic_FULL_SECRET","deviceId":"stable-device-id"}'

# Refresh the session.
curl --fail-with-body https://licenses.example.com/v1/heartbeat \
  -H "Content-Type: application/json" \
  --data '{"sessionToken":"SERVER_ISSUED_TOKEN","deviceId":"stable-device-id"}'

# Release the session.
curl --fail-with-body https://licenses.example.com/v1/deactivate \
  -H "Content-Type: application/json" \
  --data '{"sessionToken":"SERVER_ISSUED_TOKEN","deviceId":"stable-device-id"}'
```

## System routes

| Route | Purpose | Success |
| --- | --- | --- |
| `GET /health` | Process liveness; does not query dependencies. | `200 { "status": "ok" }` |
| `GET /ready` | PostgreSQL and Redis readiness. | `200 { "status": "ready" }` or `503 { "status": "unavailable" }` |
| `GET /docs` | Interactive API documentation, when enabled. | `200` |
| `GET /docs/openapi.json` | Generated OpenAPI document, when enabled. | `200` |

## Runtime license API

Runtime sessions are bound to the source IP and `deviceId`. A heartbeat or usage call re-evaluates the current license type, status, expiry, allowlists, metadata, and session revision. Those policy changes take effect on the next request. `maxIps` and `maxDevices` gate future registrations, while `maxSessions` gates future activations; lower limits do not silently eject an existing valid session. Sessions expire after the returned TTL unless heartbeats refresh them.

### `POST /v1/activate`

Validates the full secret, registers the IP/device when allowed, starts a new trial on its first successful activation, and creates a session.

Request:

```json
{
  "licenseKey": "lic_FULL_SECRET",
  "deviceId": "stable-device-id"
}
```

Response `200`:

```json
{
  "success": true,
  "licenseType": "lifetime",
  "metadata": { "tier": "pro" },
  "sessionToken": "SERVER_ISSUED_TOKEN",
  "sessionTtlSeconds": 45
}
```

### `POST /v1/heartbeat`

Revalidates current policy and refreshes the bound session.

```json
{
  "sessionToken": "SERVER_ISSUED_TOKEN",
  "deviceId": "stable-device-id"
}
```

Response `200` has the same shape as activation and may contain a changed `licenseType` or `metadata`.

### `POST /v1/usage`

Atomically consumes a positive number of units from a named meter. Activation and heartbeats never debit meters.

```json
{
  "sessionToken": "SERVER_ISSUED_TOKEN",
  "deviceId": "stable-device-id",
  "meter": "exports",
  "units": 2,
  "eventId": "export-job-018f"
}
```

Response `200`:

```json
{
  "success": true,
  "meter": "exports",
  "units": 2,
  "eventId": "export-job-018f",
  "remaining": 98
}
```

`eventId` is required and unique per license. Retrying the identical meter, units, and event ID returns the original result without another debit. Reusing an event ID with different data returns `409 USAGE_EVENT_CONFLICT`.

### `POST /v1/deactivate`

Immediately releases the bound session. The operation is idempotent, including for an unknown or already removed session.

```json
{
  "sessionToken": "SERVER_ISSUED_TOKEN",
  "deviceId": "stable-device-id"
}
```

Response `200`:

```json
{ "success": true }
```

### Stable runtime error codes

| Code | Typical status | Meaning |
| --- | --- | --- |
| `INVALID_REQUEST` | `400` | Invalid body or operation for the current license type. |
| `LICENSE_INVALID` | `403` | The activation secret is unknown. |
| `LICENSE_REVOKED` | `403` | Manual or billing revocation blocks access. |
| `LICENSE_EXPIRED` | `403` | A subscription or trial is no longer valid. |
| `IP_NOT_ALLOWED` | `403` | The restrictive IP allowlist rejected the source IP. |
| `DEVICE_NOT_ALLOWED` | `403` | The restrictive device allowlist rejected `deviceId`. |
| `SESSION_INVALID_OR_EXPIRED` | `403` | The session is missing, expired, or does not match its IP/device binding. |
| `CONCURRENT_SESSION_LIMIT` | `403` | `maxSessions` is reached. |
| `METER_NOT_FOUND` | `404` | The named meter does not exist. |
| `METER_ARCHIVED` | `409` | The named meter is archived. |
| `METER_EXHAUSTED` | `403` | The meter lacks enough units. |
| `USAGE_EVENT_CONFLICT` | `409` | An `eventId` was reused with different usage data. |
| `IP_REGISTRATION_LIMIT` | `403` | `maxIps` is reached. |
| `DEVICE_REGISTRATION_LIMIT` | `403` | `maxDevices` is reached. |
| `RATE_LIMITED` | `429` | The request budget is exhausted. |
| `INTERNAL_ERROR` | `500` | An unexpected server failure occurred. |

## Administrative authentication

Send the primary or rotation credential on every `/admin/*` request:

```http
X-Admin-Key: your-random-administrator-secret
```

Missing or invalid credentials return `401`:

```json
{ "error": "Unauthorized", "code": "UNAUTHORIZED" }
```

These APIs expose private customer, access, and billing data. Restrict them at the network layer as well as authenticating them.

## Customers

Customer fields are `id`, `email`, `name`, `metadata`, `createdAt`, and `updatedAt`. Email is normalized and unique. Customer metadata is operator data; only license metadata is returned to a licensed product.

| Route | Body or behavior |
| --- | --- |
| `POST /admin/customers` | Create with `{ email, name, metadata? }`; returns `201`. |
| `GET /admin/customers` | List customers. |
| `GET /admin/customers/:id` | Get one customer. |
| `PATCH /admin/customers/:id` | Update one or more of `email`, `name`, or `metadata`. |
| `DELETE /admin/customers/:id` | Permanently delete the customer and cascaded licenses; returns `204`. |

## Licenses

### Types and fields

Create a license with `POST /admin/licenses`:

```json
{
  "customerId": "CUSTOMER_ID",
  "type": "metered",
  "maxIps": 2,
  "maxDevices": 2,
  "maxSessions": 1,
  "metadata": { "plan": "pro" },
  "meters": [
    { "name": "exports", "balance": 100, "reason": "Initial allocation" }
  ]
}
```

| Field | Required/default | Meaning |
| --- | --- | --- |
| `customerId` | Required | Existing customer ID. |
| `type` | Required | `lifetime`, `subscription`, `metered`, or `trial`. |
| `maxIps` | `0` | Maximum registered IP slots; `0` is unlimited. |
| `maxDevices` | `0` | Maximum registered device slots; `0` is unlimited. |
| `maxSessions` | `0` | Maximum active sessions; `0` is unlimited. |
| `metadata` | `{}` | JSON returned by activation and heartbeat. Do not store secrets here. |
| `expiresAt` | Type-specific | Future timestamp required by `subscription`. |
| `trialDurationMinutes` | Type-specific | Positive duration required by `trial`. |
| `meters` | Type-specific | At least one unique `{ name, balance, reason }` required by `metered`. |

Type behavior:

- `lifetime` has no type-level expiry or usage balance.
- `subscription` expires at `expiresAt` and can be renewed manually or synchronized from an optional Stripe link.
- `metered` is debited only by explicit usage calls.
- `trial` starts its duration on first activation. Converting an active license to trial starts a fresh trial immediately.

Changing type keeps the same secret, customer, common limits, allowlists, and registered devices. Type-specific settings remain in `typeDrafts` for later switching. A Stripe-linked subscription requires `confirmStripeUnlink: true` when changing to another type.

Every normal license response contains `keyPrefix`, never the complete secret. Only successful creation and key rotation add `licenseKey`. New secrets start with `lic_`; store them immediately because the server stores only their hash.

The server returns an effective status object:

```json
{
  "status": "revoked",
  "reason": "manual_revocation"
}
```

`status` is `active`, `expired`, or `revoked`; `reason` is `manual_revocation`, `billing_revocation`, `subscription_expired`, `trial_expired`, or `null`.

### Core routes and actions

| Route | Body or behavior |
| --- | --- |
| `POST /admin/licenses` | Create a license; returns `201` and the one-time `licenseKey`. |
| `GET /admin/licenses` | List licenses using `keyPrefix`. |
| `GET /admin/licenses/:id` | Get one license using `keyPrefix`. |
| `PATCH /admin/licenses/:id` | Update mutable fields or change type. Changes apply on the next runtime request. |
| `DELETE /admin/licenses/:id` | Permanently delete a license and terminate its sessions; returns `204`. |
| `POST /admin/licenses/:id/actions/renew` | Manually renew a subscription with `{ "expiresAt": "..." }`. |
| `POST /admin/licenses/:id/actions/revoke` | Manually revoke with `{ "reason": "..." }` and terminate sessions. |
| `POST /admin/licenses/:id/actions/restore` | Clear only the manual revocation. |
| `POST /admin/licenses/:id/actions/rotate-key` | Replace the secret, terminate sessions, and return the new one-time `licenseKey`. |
| `POST /admin/licenses/:id/actions/terminate-sessions` | Terminate active sessions; returns `{ "terminated": number }`. |
| `POST /admin/licenses/:id/actions/reset-devices` | Clear all registered IP/device slots and terminate sessions; returns `{ "removed": number }`. |

### Access, allowlists, and registrations

Registered IP/device slots are separate from explicit allowlists. An empty allowlist is unrestricted; adding its first entry makes that dimension restrictive and returns a warning. Removing registrations frees slots but does not change allowlists.

| Route | Body or behavior |
| --- | --- |
| `GET /admin/licenses/:id/access` | Return allowed IPs/devices, registered devices, and attempted IP/device summaries. This is the protected view containing exact identifiers. |
| `POST /admin/licenses/:id/allowlists/ips` | Add `{ "ip": "203.0.113.10" }`; returns the entry, `restrictionEnabled`, and warning. |
| `DELETE /admin/licenses/:id/allowlists/ips/:ip` | Remove an allowed IP. URL-encode the path value. |
| `POST /admin/licenses/:id/allowlists/devices` | Add `{ "deviceId": "stable-device-id" }`; returns the entry, `restrictionEnabled`, and warning. |
| `DELETE /admin/licenses/:id/allowlists/devices/:deviceId` | Remove an allowed device. URL-encode the path value. |
| `DELETE /admin/licenses/:id/registrations/ips/:ip` | Remove matching registrations, terminate sessions when any are removed, and return `{ "removed": number }`. |
| `DELETE /admin/licenses/:id/registrations/devices/:deviceId` | Remove matching registrations, terminate sessions when any are removed, and return `{ "removed": number }`. |

### Meters and usage ledger

Meter names are immutable. Balances never become negative. Operator meter lifecycle and balance changes require a reason and create durable ledger entries.

| Route | Body or behavior |
| --- | --- |
| `GET /admin/licenses/:id/meters?includeArchived=false` | List meters; set `includeArchived=true` to include archived meters. |
| `POST /admin/licenses/:id/meters` | Create `{ "name": "exports", "balance": 100, "reason": "initial allocation" }`. |
| `POST /admin/licenses/:id/meters/:name/actions/archive` | Archive with `{ "reason": "retired feature" }`. An active metered license must retain at least one active meter. |
| `POST /admin/licenses/:id/meters/:name/actions/top-up` | Add units with `{ "units": 100, "reason": "renewal" }`. |
| `POST /admin/licenses/:id/meters/:name/actions/adjust` | Apply a non-zero signed change with `{ "delta": -5, "reason": "correction" }`. |
| `GET /admin/licenses/:id/usage-ledger?meter=exports` | List create, consume, top-up, adjustment, and archive entries; omit `meter` for all meters. |

Ledger entries include `eventId`, `kind`, `delta`, `balanceBefore`, `balanceAfter`, `reason`, and `createdAt`. For application consumption, `eventId` is the stored SHA-256 digest rather than the caller-provided idempotency value.

## Activity and statistics

| Route | Response |
| --- | --- |
| `GET /admin/activity` | Retained detailed activity events, newest first. |
| `GET /admin/statistics` | Lifetime totals, minute buckets, and recent detailed events. |

Both routes accept `licenseId`, `customerId`, `type`, `from`, `to`, and `limit` query filters. Dates are ISO 8601 values and `limit` is from 1 to 1000. Event types include customer and license lifecycle changes, activation attempts and outcomes, heartbeats, deactivation, meter changes, usage outcomes, and Stripe changes.

General activity responses omit exact IP and device identifiers. Use the protected per-license access route when those identifiers are required. Full license secrets and session tokens are never recorded.

## Optional Stripe routes

Stripe routes and dashboard controls are mounted only when both `KEYZORI_STRIPE_SECRET_KEY` and `KEYZORI_STRIPE_WEBHOOK_SECRET` are configured. Configuring only one is a startup error.

| Route | Body or behavior |
| --- | --- |
| `GET /admin/licenses/:id/stripe` | Return the current subscription link or `null`. |
| `POST /admin/licenses/:id/actions/link-stripe` | Link an existing subscription with `{ "subscriptionId": "sub_..." }`; only valid for a `subscription` license. |
| `POST /admin/licenses/:id/actions/unlink-stripe` | Unlink with `{ "confirm": true }`; does not alter the Stripe subscription. |
| `POST /admin/licenses/:id/actions/sync-stripe` | Retrieve and reconcile Stripe's current subscription state. |
| `POST /webhooks/stripe` | Accept a Stripe-signed raw webhook, persist its event ID, and queue reconciliation. Uses `Stripe-Signature`, not `X-Admin-Key`. |

Link records expose the subscription/customer IDs, status, paid-through time, cancellation-at-period-end flag, price ID, billing revocation time, last synchronization time, and last error.

Active and trialing subscriptions remain usable. A past-due subscription remains usable only through its paid-through time, and cancellation at period end remains usable until that time. Terminal or expired billing state applies a billing revocation. Payment recovery clears only a Stripe-originated billing revocation and never clears a manual revocation.

Keyzori does not create Checkout sessions, customer portals, claim flows, or end-user key views.

## Dashboard boundary

When enabled, the dashboard is served at `/` on `KEYZORI_SERVER_PORT` and uses separate operator credentials, Redis-backed sessions, CSRF protection, same-origin checks, and an authenticated live event stream. Its browser-facing endpoints are internal implementation details rather than an end-user or stable integration API. Set `KEYZORI_DISABLE_DASHBOARD=true` to leave all dashboard assets, login, session, JSON, and event-stream routes unmounted while retaining the API routes.
