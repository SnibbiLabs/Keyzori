# Licensing model

Every license belongs to a user and combines one key type with optional trial, IP, hardware, concurrency, whitelist, and custom-data rules.

## Key types

### `PERPETUAL`

Has no type-level expiration or usage balance. It can still be revoked and can still use trial, IP, HWID, concurrency, and whitelist rules.

### `SUBSCRIPTION`

Requires a future `expiresAt` timestamp at creation. Handshakes at or after that timestamp are rejected with `Subscription expired`.

### `USAGE`

Requires `limitUsage` greater than zero. One unit is consumed atomically when a new server-issued session token is admitted. Heartbeats using that same active token from its bound IP/HWID context do not consume another unit. Starting again after logout or TTL expiry creates a new session and consumes another unit.

## Optional trial

`trialDurationMin` can be applied to any key type. A value of `0` disables the trial rule. A positive value starts at the first successful handshake, not at key creation. At or after the activation time plus the configured duration, validation fails with `Trial has expired`.

For a subscription with a trial, the earlier effective failure wins: an expired trial or subscription rejects the handshake.

## IP and hardware limits

| Setting | `0` means | Positive value means |
| --- | --- | --- |
| `limitIp` | Unlimited distinct source IPs | Maximum distinct IP addresses registered to the license. |
| `limitHwid` | Unlimited distinct hardware IDs | Maximum distinct HWIDs registered to the license. |

Keyzori stores unique `(IP, HWID)` devices and maps them to licenses. Admission is serialized per license in PostgreSQL so parallel handshakes cannot exceed a configured IP or hardware limit.

The official SDK derives a 64-character hexadecimal SHA-256 HWID from platform, architecture, CPU count, and sorted non-internal MAC addresses. If no usable MAC address exists, it falls back to hostname. Network-adapter, VM, or host changes can therefore appear as a new device.

## Concurrent sessions

`limitConcurrent` controls active server-issued session tokens. `0` is unlimited. A positive value is enforced atomically in Redis, including stale-session cleanup, client-context verification, and TTL refresh.

The server stores each accepted session for 45 seconds and advertises that value as `sessionTtlSeconds`. The SDK treats its configured heartbeat interval as a maximum and clamps it to two-thirds of the advertised TTL, leaving a safety margin even when an application requests an unsafe interval. Calling `destroy()` logs out immediately. A process that crashes releases its slot after the last TTL expires.

Tokens are unguessable opaque values bound server-side to the admission IP/HWID context. The official SDK keeps one token inside each `LicenseClient` instance and never accepts a caller-selected session identity.

This is context-based enforcement, not hardware or process attestation. Clients behind the same public IP that deliberately reproduce the same HWID and token are indistinguishable to a self-hosted server. Products requiring resistance to a fully modified client need a platform attestation design outside Keyzori's current guarantees.

## Explicit whitelists

If a license has one or more explicit IP whitelist rows, only those IPs are accepted. If it has one or more HWID whitelist rows, only those HWIDs are accepted. An empty whitelist imposes no explicit allowlist restriction.

Whitelist checks run before dynamic registration limits. The bundled CLI and HTTP administration API do not expose whitelist-management commands; operators must not modify tables manually unless they own the migration and operational consequences.

## Custom fields

`customFields` is an arbitrary JSON object stored with the license and returned after every successful handshake. Typical uses include plan names, enabled features, tenant identifiers, or application-specific limits.

```json
{
  "tier": "pro",
  "features": ["export", "sync"],
  "tenantId": "tenant-123"
}
```

Do not store secrets in custom fields. They are returned to every application instance holding the license secret and are visible to administrators.

Customers have a separate `customFields` object for operator-only metadata such as billing IDs, company names, or internal notes. Customer fields are available through the admin API and dashboard but are never returned by handshakes or the SDK.

## Validation order

At a high level, the server:

1. Resolves the secret and rejects unknown or revoked licenses.
2. Enforces explicit IP and HWID whitelists.
3. Enforces trial and subscription expiration.
4. Atomically admits or refreshes the Redis session.
5. Serializes device registration and enforces IP/HWID limits.
6. Records first trial activation when needed.
7. Atomically consumes one usage unit for a new `USAGE` session.
8. Returns the key type and custom fields.

If a new session fails after Redis admission, Keyzori removes that session before returning the error.

## Revocation and secret storage

Revocation immediately blocks initial validation and the next heartbeat. Administrators can restore a revoked license by setting `revoked` to `false` through `PUT /admin/keys/:id` or the dashboard editor; the CLI exposes revocation but not restoration.

New secrets are generated as `sk_` plus a UUIDv7 value. PostgreSQL stores a SHA-256 digest and a display prefix, not the full secret. The committed migration backfills legacy rows, enforces non-null digests and prefixes, and drops the plaintext column.
