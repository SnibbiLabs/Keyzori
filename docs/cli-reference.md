# CLI reference

The operator CLI is part of the unified `keyzori` executable. It connects directly to the configured PostgreSQL and Redis services; it does not call the HTTP admin API.

```bash
keyzori admin --help
docker compose --file dev.docker-compose.yml exec server keyzori admin --help
```

`KEYZORI_DATABASE_URL` and `KEYZORI_REDIS_URL` are required when a command runs. Help output does not open either connection.

## Customers

```bash
keyzori admin customers create \
  --email owner@example.com \
  --name "Example Owner" \
  --metadata '{"plan":"pro"}'

keyzori admin customers list
keyzori admin customers get <customer-id>
keyzori admin customers update <customer-id> --name "New name"
keyzori admin customers delete <customer-id>
```

Deleting a customer also deletes their licenses and terminates their sessions.

## Licenses

Create one of the four canonical types:

```bash
# Lifetime
keyzori admin licenses create --customer-id <customer-id> --type lifetime

# Subscription
keyzori admin licenses create \
  --customer-id <customer-id> \
  --type subscription \
  --expires-at 2027-01-01T00:00:00Z

# Metered
keyzori admin licenses create \
  --customer-id <customer-id> \
  --type metered \
  --meter builds=1000 \
  --meter seats=25 \
  --meter-reason "Initial allocation"

# Trial
keyzori admin licenses create \
  --customer-id <customer-id> \
  --type trial \
  --trial-duration-minutes 10080
```

Common optional limits are `--max-ips`, `--max-devices`, and `--max-sessions`; `0` means unlimited. `--metadata` accepts a JSON object.

The full `licenseKey` is printed only by `licenses create` and `licenses rotate`. Store it immediately. List/get output contains only `keyPrefix`.

```bash
keyzori admin licenses list
keyzori admin licenses get <license-id>
keyzori admin licenses update <license-id> --type lifetime
keyzori admin licenses renew <license-id> --expires-at 2028-01-01T00:00:00Z
keyzori admin licenses revoke <license-id> --reason "Chargeback"
keyzori admin licenses restore <license-id>
keyzori admin licenses rotate <license-id>
keyzori admin licenses delete <license-id>
```

Changing a Stripe-linked subscription away from `subscription` requires `--unlink-stripe`. The local link is removed; the Stripe subscription is never modified.

## Access and sessions

Explicit allowlists and registered IP/device slots are separate:

```bash
keyzori admin licenses access show <license-id>
keyzori admin licenses access allow-ip <license-id> 203.0.113.10
keyzori admin licenses access remove-allowed-ip <license-id> 203.0.113.10
keyzori admin licenses access allow-device <license-id> <device-id>
keyzori admin licenses access remove-allowed-device <license-id> <device-id>
keyzori admin licenses access remove-registered-ip <license-id> 203.0.113.10
keyzori admin licenses access remove-registered-device <license-id> <device-id>
keyzori admin licenses access reset-registered-devices <license-id>
keyzori admin licenses access terminate-sessions <license-id>
```

Adding the first allowlist entry makes that dimension restrictive. Resetting registrations also terminates every active session for the license.

## Named meters

Meter names are immutable. Creating, archiving, topping up, or adjusting a meter requires an operator reason and always creates a ledger entry.

```bash
keyzori admin licenses meters list <license-id> --include-archived
keyzori admin licenses meters create <license-id> --name exports --balance 500 --reason "Initial allocation"
keyzori admin licenses meters top-up <license-id> --name exports --units 100 --reason "Monthly grant"
keyzori admin licenses meters adjust <license-id> --name exports --delta -10 --reason "Correction"
keyzori admin licenses meters archive <license-id> --name exports --reason "Retired feature"
keyzori admin licenses meters ledger <license-id> --meter exports
```

Use `keyzori admin <command> --help` for the complete option list.
