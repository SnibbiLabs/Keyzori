# Licensing model

Keyzori separates instance operators from licensed product users. Operators manage customers and licenses through the protected dashboard, admin API, or local CLI. Product users receive no Keyzori account or dashboard access; the licensed application uses the secret and session behind the scenes.

## License types

| Type | Required policy | Runtime behavior |
| --- | --- | --- |
| `lifetime` | None | Remains valid until manually revoked. |
| `subscription` | Future `expiresAt` | Expires at that time. It may be renewed manually or synchronized from Stripe. |
| `metered` | At least one active named meter | Activation and heartbeat are free. Only explicit usage reports debit balances. |
| `trial` | Positive `trialDurationMinutes` | Starts atomically on first activation. Converting an existing license to `trial` starts a fresh trial immediately. |

A type change preserves the secret, customer, metadata, limits, allowlists, and registered devices. The new policy is enforced on the next runtime request. Type-specific configuration is retained as a dormant draft so an operator can switch back without rebuilding it.

## Effective status

The server derives one status and reason for every license:

- `active`: the current type policy permits access.
- `expired`: a subscription expiry or started trial deadline has passed.
- `revoked`: a manual revocation or Stripe billing revocation is active.

Manual and Stripe revocations are independent. Payment recovery can clear only a Stripe-originated revocation.

## Device, IP, and session controls

`maxIps`, `maxDevices`, and `maxSessions` are non-negative integers. `0` means unlimited.

Registered IP and device slots record successful activation contexts. Operators can remove one IP or device registration, reset all registrations, and terminate active sessions. These records are separate from explicit allowlists:

- an empty IP allowlist accepts any IP subject to `maxIps`;
- once the first IP entry is added, only listed IPs are accepted;
- an empty device allowlist accepts any device subject to `maxDevices`;
- once the first device entry is added, only listed device IDs are accepted.

Enabling the first allowlist is intentionally restrictive and the dashboard warns before doing so. Registration is serialized per license so concurrent activations cannot overrun either limit.

Sessions are opaque server-issued tokens stored in Redis, bound to the activation IP and `deviceId`, and refreshed by heartbeat. The license secret is sent only for activation. Rotation and revocation terminate existing sessions.

## Named usage meters

Meter names are immutable within a license. Operators may create, archive, top up, or adjust a meter. Every operator meter lifecycle or balance change requires a reason and creates a durable ledger entry.

Applications consume usage through `POST /v1/usage` with a positive integer `units` value and a per-license `eventId`:

- the debit and ledger insertion are one atomic transaction;
- an identical retry returns the original result without a second debit;
- reuse of an `eventId` with different meter or units returns `USAGE_EVENT_CONFLICT`;
- archived, missing, or exhausted meters reject consumption without changing a balance.

The usage response echoes the caller's `eventId`, but the durable operator ledger stores only its SHA-256 digest.

## Metadata and secret handling

`metadata` is arbitrary JSON returned after successful activation and heartbeat. It must not contain secrets because every licensed application holding the license can read it.

New secrets start with `lic_`. The full `licenseKey` is returned only after creation or rotation; all later operator responses expose `keyPrefix`. Migrated `sk_` secrets remain valid because their stored hashes are preserved.

## Stripe-managed subscriptions

When Stripe is configured, an operator may link an existing Stripe subscription to a `subscription` license. Keyzori does not create Checkout sessions, expose a customer portal, or give product users access to licensing controls.

Current Stripe state is reconciled after every relevant webhook, so retries and event ordering do not determine access. `active`, `trialing`, and paid-through `past_due` subscriptions remain usable. Terminal or no-longer-paid-through state creates a billing revocation. Changing the license to another type unlinks it after operator confirmation and never modifies the Stripe subscription.
