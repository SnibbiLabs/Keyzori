# HTTP API reference

The Keyzori server exposes system, license, and administrative routes. Interactive Scalar documentation is available at `/docs`, and the generated OpenAPI document is at `/docs/openapi.json` when `OPENAPI_ENABLED=true`.

## Conventions

- Requests and normal responses use `application/json`.
- Administrative routes require `X-Admin-Key`.
- License routes carry the license secret in the JSON body.
- Timestamps are serialized as ISO 8601 strings.
- Validation and domain failures use `{ "error": "message", "code": "STABLE_CODE" }`.
- Runtime routes use a 30-request/minute hashed-principal budget plus a coarse 6,000-request/minute IP ceiling. Admin routes retain a 60-request/minute IP budget.
- Rate-limit failures return HTTP `429`, a `Retry-After` header, and `{ "error": "Too Many Requests", "code": "RATE_LIMITED" }`.
- System, license, and admin responses include `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`.

The configured body-size ceiling applies before route validation. The default is 65,536 bytes.

## End-to-end curl example

The following sequence creates an owner and key, validates and releases a session, then revokes the key. Replace the placeholder IDs and secret with values returned by the preceding request. Avoid placing production secrets directly in shell history.

```bash
# 1. Create an owner; copy its id.
curl --fail-with-body https://licenses.example.com/admin/users \
  -H "X-Admin-Key: $KEYZORI_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  --data '{"email":"owner@example.com","name":"Example Owner"}'

# 2. Create a key; securely store the one-time key value.
curl --fail-with-body https://licenses.example.com/admin/keys \
  -H "X-Admin-Key: $KEYZORI_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  --data '{"userId":"OWNER_ID","type":"PERPETUAL","limitHwid":1,"limitConcurrent":1}'

# 3. Start a runtime session; copy sessionToken from the response.
curl --fail-with-body https://licenses.example.com/v1/handshake \
  -H "Content-Type: application/json" \
  --data '{"apiKey":"FULL_KEY_SECRET","hwid":"stable-device-id"}'

# 4. Release the runtime session.
curl --fail-with-body https://licenses.example.com/v1/logout \
  -H "Content-Type: application/json" \
  --data '{"apiKey":"FULL_KEY_SECRET","hwid":"stable-device-id","sessionToken":"SERVER_ISSUED_TOKEN"}'

# 5. Revoke the key using its internal id, not its secret.
curl --fail-with-body --request PATCH https://licenses.example.com/admin/keys/KEY_ID \
  -H "X-Admin-Key: $KEYZORI_ADMIN_KEY"
```

## System routes

### `GET /health`

Process liveness check. It does not query PostgreSQL or Redis.

Response `200`:

```json
{ "status": "ok" }
```

### `GET /ready`

Dependency readiness check. It executes a PostgreSQL query and a Redis `PING`.

Response `200`:

```json
{ "status": "ready" }
```

Response `503`:

```json
{ "status": "unavailable" }
```

Use `/health` for liveness and `/ready` for traffic admission.

## License routes

### `POST /v1/handshake`

Validates a license and either creates a new 45-second session or refreshes an existing server-issued session token. Each token is bound to the original client IP and HWID.

Request:

```json
{
  "apiKey": "sk_019...",
  "hwid": "sha256-host-identifier"
}
```

| Field | Constraints | Description |
| --- | --- | --- |
| `apiKey` | String, 1–128 characters | Full license secret returned at creation. |
| `hwid` | String, 1–128 characters | Stable device identifier. The official SDK supplies this automatically. |
| `sessionToken` | Optional string, 32–128 characters | Omit on initial admission; reuse the opaque token returned by the server for heartbeats. |

Response `200`:

```json
{
  "success": true,
  "type": "PERPETUAL",
  "customFields": {
    "tier": "pro"
  },
  "sessionToken": "7db7029c-0fe7-42e1-a14b-a14e468b752b",
  "sessionTtlSeconds": 45
}
```

Possible responses:

| Status | Meaning |
| --- | --- |
| `200` | License accepted and session created or refreshed. |
| `400` | Request body failed schema validation. |
| `403` | License, whitelist, expiry, usage, concurrency, IP, or HWID rule rejected the request. |
| `429` | Client exceeded the configured request budget. |
| `500` | Unexpected PostgreSQL, Redis, or server failure. |

Runtime `403` codes are `LICENSE_INVALID_OR_REVOKED`, `IP_NOT_WHITELISTED`, `HWID_NOT_WHITELISTED`, `TRIAL_EXPIRED`, `SUBSCRIPTION_EXPIRED`, `SESSION_INVALID_OR_EXPIRED`, `CONCURRENT_SESSION_LIMIT`, `USAGE_EXHAUSTED`, `IP_REGISTRATION_LIMIT`, and `HWID_REGISTRATION_LIMIT`. Generic errors use `INVALID_REQUEST`, `UNAUTHORIZED`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, or `INTERNAL_ERROR`.

### `POST /v1/logout`

Releases a session immediately instead of waiting for its Redis TTL.

Request:

```json
{
  "apiKey": "sk_019...",
  "hwid": "sha256-host-identifier",
  "sessionToken": "7db7029c-0fe7-42e1-a14b-a14e468b752b"
}
```

The key is 1–128 characters, the HWID is 1–128 characters, and the server-issued token is 32–128 characters. Logout releases only a session matching the original IP/HWID context.

Response `200`:

```json
{ "success": true }
```

Logout deliberately returns success for unknown or already removed licenses/sessions. This makes cleanup idempotent and avoids revealing whether a secret exists.

## Administrative authentication

Send the configured primary or rotation credential on every `/admin/*` request:

```http
X-Admin-Key: your-random-administrator-secret
```

Missing or invalid credentials return `401`:

```json
{ "error": "Unauthorized", "code": "UNAUTHORIZED" }
```

Restrict these routes at the network layer in production even when header authentication is enabled.

The optional standalone dashboard is a server-side client of these routes. It keeps `X-Admin-Key` out of the browser and exposes only its allowlisted customer and license proxy endpoints.

## Customer administration

Customer records use `/admin/users` for backward-compatible API naming. Their custom fields are administrative-only and are distinct from client-visible license custom fields.

### `POST /admin/users`

Creates a license owner.

Request:

```json
{
  "email": "owner@example.com",
  "name": "Example Owner",
  "customFields": {
    "company": "Example Co",
    "accountId": "acct_123"
  }
}
```

The email must be valid and no longer than 254 characters. The name must be 1–200 characters. `customFields` is an optional JSON object and defaults to `{}`. The application trims both text fields and lowercases the email. PostgreSQL enforces unique email addresses.

Response `201`:

```json
{
  "id": "01234567-89ab-cdef-0123-456789abcdef",
  "email": "owner@example.com",
  "name": "Example Owner",
  "customFields": {
    "company": "Example Co",
    "accountId": "acct_123"
  },
  "createdAt": "2026-07-18T10:00:00.000Z"
}
```

Possible responses: `201`, `400`, `401`, `409`, or `500`. Duplicate owner email addresses return safe `409 CONFLICT` responses.

### `GET /admin/users`

Returns all owners in newest-first order.

Response `200` is an array of the user object shown above. Possible responses: `200`, `401`, or `500`.

### `GET /admin/users/:id`

Returns one owner by internal ID. Possible responses: `200`, `401`, `404`, or `500`.

### `PATCH /admin/users/:id`

Updates an owner's `email`, `name`, `customFields`, or any combination of them. Email normalization and uniqueness rules are the same as creation. Customer custom fields are administrative metadata and are not returned by the license handshake; use license custom fields for client-visible data. Possible responses: `200`, `400`, `401`, `404`, `409`, or `500`.

### `DELETE /admin/users/:id`

Permanently deletes the owner. PostgreSQL also deletes every license owned by that user through the configured cascade. Response `200` is `{ "success": true }`. Possible responses: `200`, `401`, `404`, or `500`.

## License administration

### `POST /admin/keys`

Creates a license for an existing user. This response is the only API response containing the complete secret.

Request:

```json
{
  "userId": "01234567-89ab-cdef-0123-456789abcdef",
  "type": "SUBSCRIPTION",
  "limitIp": 2,
  "limitHwid": 2,
  "limitConcurrent": 1,
  "limitUsage": 0,
  "trialDurationMin": 0,
  "customFields": {
    "tier": "pro",
    "features": ["export"]
  },
  "expiresAt": "2027-01-01T00:00:00.000Z"
}
```

| Field | Required | Default | Constraints |
| --- | --- | --- | --- |
| `userId` | Yes | — | String, 1–64 characters; must identify an existing user. |
| `type` | Yes | — | `PERPETUAL`, `SUBSCRIPTION`, or `USAGE`. |
| `limitIp` | No | `0` | Integer `0`–`2147483647`; `0` is unlimited. |
| `limitHwid` | No | `0` | Integer `0`–`2147483647`; `0` is unlimited. |
| `limitConcurrent` | No | `0` | Integer `0`–`2147483647`; `0` is unlimited. |
| `limitUsage` | No | `0` | Integer `0`–`2147483647`; positive for `USAGE`. |
| `trialDurationMin` | No | `0` | Integer `0`–`2147483647`; starts on first successful handshake. |
| `customFields` | No | `{}` | JSON object returned by successful handshakes. Values may contain JSON strings, numbers, booleans, `null`, arrays, or nested objects. |
| `expiresAt` | Conditional | `null` | Future ISO timestamp required only for `SUBSCRIPTION`. |

Response `201`:

```json
{
  "id": "key-id",
  "key": "sk_019...full-secret",
  "userId": "user-id",
  "type": "SUBSCRIPTION",
  "limitIp": 2,
  "limitHwid": 2,
  "limitConcurrent": 1,
  "limitUsage": 0,
  "trialDurationMin": 0,
  "firstActivatedAt": null,
  "customFields": { "tier": "pro" },
  "expiresAt": "2027-01-01T00:00:00.000Z",
  "revoked": false,
  "createdAt": "2026-07-18T10:00:00.000Z"
}
```

Store `key` immediately. New secrets are SHA-256 hashed in PostgreSQL and cannot be reconstructed.

Possible responses: `201`, `400`, `401`, `404`, or `500`.

### `GET /admin/keys`

Returns all licenses in newest-first order. The shape matches the creation response, except `key` is a non-secret prefix ending in `...`.

```json
[
  {
    "id": "key-id",
    "key": "sk_019abc123...",
    "userId": "user-id",
    "type": "PERPETUAL",
    "limitIp": 0,
    "limitHwid": 1,
    "limitConcurrent": 1,
    "limitUsage": 0,
    "trialDurationMin": 0,
    "firstActivatedAt": "2026-07-18T10:05:00.000Z",
    "customFields": {},
    "expiresAt": null,
    "revoked": false,
    "createdAt": "2026-07-18T10:00:00.000Z"
  }
]
```

Possible responses: `200`, `401`, or `500`.

### `GET /admin/keys/:id`

Returns one masked license record by internal ID. Possible responses: `200`, `401`, `404`, or `500`.

### `PUT /admin/keys/:id`

Updates one or more mutable license fields: owner, type, limits, trial duration, custom fields, expiry, or revoked state. Changing away from `SUBSCRIPTION` clears expiry when it is omitted; changing to `SUBSCRIPTION` requires a future `expiresAt`. Response `200` is the updated masked license. Possible responses: `200`, `400`, `401`, `404`, or `500`.

### `PATCH /admin/keys/:id`

Marks a license as revoked. The path uses the internal key ID, not the `sk_...` secret.

Response `200` is the updated license object with a masked `key` and `revoked: true`. Possible responses: `200`, `401`, `404`, or `500`.

### `DELETE /admin/keys/:id`

Permanently deletes a license and its associated registration mappings and allowlists. Response `200` is `{ "success": true }`. Possible responses: `200`, `401`, `404`, or `500`.

## Documentation routes

When enabled:

| Route | Description |
| --- | --- |
| `GET /docs` | Interactive Scalar UI. |
| `GET /docs/openapi.json` | Generated OpenAPI document. |

Set `OPENAPI_ENABLED=false` when production policy does not permit public API documentation.
