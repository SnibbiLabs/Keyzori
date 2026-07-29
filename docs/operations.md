# Operating Keyzori

Use this guide to back up, upgrade, monitor, and recover a running Keyzori installation. Adapt retention, encryption, alerts, and recovery targets to your deployment.

## Before deployment

1. Record the image digest and source tag.
2. Back up PostgreSQL with the provider snapshot feature or `pg_dump --format=custom`.
3. Restore the backup into an isolated database and run `pg_restore --list` plus an application readiness check.
4. Confirm Redis is private and disposable; active sessions can be rebuilt after restart.
5. Run migrations against a recent restored copy before the production rollout.

## Rollout

Deploy one revision, allow startup migrations to complete, then require `/ready` to return HTTP 200 before shifting traffic. Keep the previous image digest and database backup until the observation window closes.

Monitor HTTP 5xx and 429 rates by budget (admin IP, license principal, and coarse IP), readiness failures, process restarts, PostgreSQL connections/latency/storage, Redis memory/latency/evictions, and failed administrative operations. Logs and traces must redact request bodies, license secrets, admin credentials, database URLs, HWIDs, and raw client IPs unless the operator has an explicit privacy policy for them. Redis rate-limit keys contain only SHA-256 derivatives of credentials.

## Rollback

- If no migration ran, redeploy the previous image digest.
- If a backward-compatible migration ran, redeploy only when the previous application version is documented as compatible.
- If a destructive or incompatible migration ran, stop writes, restore the pre-deployment backup to a new database, point the previous image at it, verify `/ready`, and then restore traffic.

Never edit an already-applied migration. Create a new corrective migration or restore a backup. The non-negative license-limit migration intentionally fails if manually inserted negative legacy data exists; repair it explicitly instead of rewriting values during rollout.

## Recovery exercises

At least quarterly, measure backup age, restore duration, data-loss window, migration duration, and time to healthy traffic. Before a major release, run a load/soak test through the intended TLS proxy and dependency topology, including Redis/PostgreSQL interruption and rate-limit saturation.

## Secrets

Store `ADMIN_API_KEY`, rotation keys, database credentials, and Redis credentials in the platform secret manager. Rotate the admin key using `ADMIN_API_KEYS`, then remove the old value. Revoke and replace any exposed license secret; hashed values cannot be recovered.
