<div align="center">

# Keyzori License Manager

**Self-hosted licensing for software products.**

[`Documentation`](docs/README.md) · [`API`](docs/api-reference.md) · [`SDK`](apps/sdk/README.md) · [`Deployment`](docs/deployment.md)

<br />

<code>Bun</code> <code>TypeScript</code> <code>Elysia</code> <code>PostgreSQL</code> <code>Redis</code> <code>Drizzle</code>

</div>

> [!WARNING]
> Keyzori is under active development and this release intentionally contains breaking API and database naming changes.

Keyzori ships one server image containing the API and admin CLI, plus a typed client SDK. You control the server, PostgreSQL database, Redis instance, and licensing data.

## License types

| Type | Behavior |
| --- | --- |
| `lifetime` | No type-level expiry or usage balance. |
| `subscription` | Requires an expiry and supports manual or optional Stripe renewal synchronization. |
| `metered` | Uses explicit, idempotent consumption against named integer meters. |
| `trial` | Starts a positive duration atomically on first activation. |

Every type can use IP, device, session, allowlist, metadata, revocation, and access-management controls. Type changes preserve the secret and shared policy while keeping former type settings as dormant drafts.

## Quick start

Keyzori requires Bun, PostgreSQL, and Redis.

```powershell
Copy-Item .env.example .env
# Replace every placeholder secret and configure dependency URLs.
bun run setup
bun run dev
```

The API starts at `http://localhost:3000`:

| URL | Purpose |
| --- | --- |
| `/health` | Process liveness |
| `/ready` | PostgreSQL and Redis readiness |
| `/docs` | Interactive operator/runtime API reference |

Use `keyzori admin` or the authenticated `/admin/*` API to create a customer and license. The full `lic_...` secret is returned only after creation or rotation; store it immediately.

## SDK integration

```typescript
import { LicenseClient } from "keyzori";

const license = new LicenseClient({
  licenseKey: process.env.KEYZORI_LICENSE_KEY ?? "",
  serverUrl: "https://licenses.example.com",
  deviceId: process.env.KEYZORI_DEVICE_ID,
});

const { licenseType, metadata } = await license.activate();

await license.consume({
  meter: "exports",
  units: 1,
  eventId: crypto.randomUUID(),
});

await license.deactivate();
```

Only activation sends the license secret. Automatic heartbeats, usage, and deactivation use a bound server-issued session token. See the [SDK reference](docs/sdk-reference.md) and [runtime flow](docs/runtime-flow.md).

## Docker

```powershell
docker compose --file dev.docker-compose.yml up --build -d
docker compose --file dev.docker-compose.yml exec server keyzori admin --help
```

The server image runs as non-root with a read-only filesystem and contains one compiled `keyzori` executable:

- `keyzori serve`
- `keyzori admin ...`
- `keyzori healthcheck`

Stripe controls and webhook processing are absent unless both `KEYZORI_STRIPE_SECRET_KEY` and `KEYZORI_STRIPE_WEBHOOK_SECRET` are configured. Keyzori links existing subscriptions only; it does not provide Checkout, a customer portal, or end-user licensing controls.

## Development

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the API in watch mode |
| `bun run cli:help` | Show local operator commands |
| `bun run build` | Build the unified server executable and SDK |
| `bun run typecheck` | Type-check all workspaces and cross-app tests |
| `bun run test` | Run the test suite |
| `bun run check` | Run release-level verification |
| `bun run db:generate` | Generate a migration after schema changes |
| `bun run db:migrate` | Apply committed migrations |
| `bun run docker:build` | Build the optimized server image |
| `bun run docker:build:server` | Alias for the unified image build |

## Documentation

- [Licensing model](docs/licensing-model.md)
- [Product flow](docs/product-flow.md)
- [HTTP API](docs/api-reference.md)
- [Admin CLI](docs/cli-reference.md)
- [Configuration](docs/configuration.md)
- [Deployment](docs/deployment.md)
- [Operations](docs/operations.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture](docs/architecture.md)

## Community and license

[Contributing](CONTRIBUTING.md) · [Governance](GOVERNANCE.md) · [Support](https://tsukiyo.cc/join)

Licensed under the [Apache License 2.0](LICENSE).
