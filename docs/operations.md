# Operations

## Monitor

Track `/ready`, HTTP 5xx/429 rates, activation rejection reasons, Stripe synchronization failures, process restarts, PostgreSQL latency/storage, and Redis latency/memory/evictions. The dashboard Statistics page provides lifetime totals, time buckets, filters, and a live SSE feed.

Detailed activity is pruned after `KEYZORI_EVENT_RETENTION_DAYS`; lifetime totals remain. Heartbeats also update minute buckets. The operator dashboard requests the latest 24 hours and reduces them to at most 96 fifteen-minute chart points, while SSE reconnections reload durable recent activity. Logs and exported telemetry must never contain full license keys, admin/dashboard credentials, database URLs, raw request bodies, or unscoped IP/device identifiers.

## Back up and restore

Back up PostgreSQL with a tested point-in-time or scheduled recovery process. It contains customers, license hashes and policy, access registrations, meters and ledger entries, activity totals, and Stripe synchronization state.

Redis data can be recreated, but a Redis loss invalidates active application sessions and dashboard logins. Plan for clients to activate again and operators to sign in again after recovery.

Before restoring production data:

1. stop write traffic;
2. restore PostgreSQL to a consistent point;
3. apply committed migrations with the matching Keyzori release;
4. clear or replace Redis session data if its state is not from the same point;
5. start Keyzori and wait for `/ready`;
6. reconcile linked Stripe subscriptions from current Stripe state.

## Deploy and recover

Before every deployment, record the exact release image tag and take a tested PostgreSQL backup. Start the new image, let it apply its committed migrations, and shift traffic only after `/ready` succeeds. Confirm both the dashboard state you selected and `keyzori admin --help` during the rollout.

This release is a clean contract break and does not provide old API, SDK, CLI, or schema aliases. Do not run an older Keyzori binary against a database migrated by this release. Recovery means stopping writes and restoring the matching pre-deployment database backup with the matching release image tag.

## Rotate secrets

- Rotate the admin API key by putting the new value in `KEYZORI_ADMIN_API_KEY` and the previous value temporarily in `KEYZORI_ADMIN_API_KEYS`.
- Change the dashboard password independently; existing Redis sessions remain until expiry unless its session keys are cleared.
- Rotate a license through the explicit rotate action. The new full `licenseKey` is shown once and all existing runtime sessions are terminated.
- When changing a Stripe webhook secret, update Stripe and Keyzori together so signature verification is never silently bypassed.

## Privacy and retention

Activity feeds show only identifiers needed to locate a customer or license. Exact IP and device values are limited to the authenticated per-license access view. Choose the shortest detailed retention period compatible with support and audit needs, and document any export or backup retention separately.

## Incident actions

- Compromised license: rotate or revoke it and verify session termination.
- Unexpected device/IP exhaustion: inspect registrations, remove the affected slot, and confirm whether an explicit allowlist became restrictive.
- Meter dispute: inspect the immutable usage ledger and its stored event-ID digest; adjust only with a documented operator reason.
- Stripe mismatch: request a manual synchronization. It retrieves the current subscription rather than replaying old webhook state.
- Dashboard credential attack: check Redis-backed throttling and proxy IP trust before increasing limits.
