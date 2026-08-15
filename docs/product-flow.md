# Product flow

## Operator setup

1. The instance operator signs in to the optional embedded dashboard or uses `keyzori admin`.
2. They create a `Customer`, then create a `License` with one of the four supported types.
3. Keyzori reveals the new `licenseKey` once. Later views show only `keyPrefix`.
4. For a metered license, the operator creates one or more named meters. For a Stripe-managed subscription, they link an existing Stripe subscription.
5. The operator securely provisions the secret to the licensed application. The product user does not receive a Keyzori login or management interface.

## Application runtime

1. The SDK derives or accepts a stable `deviceId` and calls `activate()` with the secret.
2. The server applies current status, expiry, allowlist, registration, and concurrency policy, then returns a bound session token.
3. The SDK refreshes that token automatically through heartbeat. The secret is not resent.
4. Metered work is reported explicitly with `consume({ meter, units, eventId })`; retries are idempotent.
5. `deactivate()` releases the session immediately. Redis expiry remains the fallback after an unclean shutdown.

## Operator feedback

Every material management or runtime action updates lifetime totals. Detailed audit, rejection, and usage records are retained for the configured window, while the dashboard aggregates the latest 24 hours of minute buckets into at most 96 chart points. Authenticated dashboard sessions receive sanitized activity over SSE and reload durable recent activity whenever the stream connects or reconnects.

Operators can revoke or restore a license, rotate its secret, terminate sessions, release registered IP/device slots, manage allowlists, and create, archive, top up, or adjust meters with an audited reason. Type, status, expiry, allowlist, metadata, and session-revision changes apply on the next runtime request. Registration and concurrency limits gate future registrations or activations rather than silently ejecting a valid session.
