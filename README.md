<div align="center">

# Keyzori License Manager

**Self-hosted license management for software products.**

Create, validate, meter, hardware-lock, and revoke licenses through one focused Bun and TypeScript stack.

[`Documentation`](docs/README.md) · [`API reference`](docs/api-reference.md) · [`SDK guide`](apps/sdk/README.md) · [`Deployment`](docs/deployment.md)

<br />

<code>Bun</code> <code>TypeScript</code> <code>Elysia</code> <code>PostgreSQL</code> <code>Redis</code> <code>Drizzle</code>

</div>

> [!NOTE]
> Keyzori is self-hosted. You control the server, PostgreSQL database, Redis instance, license data, and deployment environment.

> [!WARNING]
> Keyzori is still under active development. Expect bugs, instability, missing features, and breaking changes.

## What is Keyzori?

Keyzori is a self-hosted licensing system with one deployable server runtime and one publishable client SDK. The server runtime exposes both HTTP and in-container CLI delivery interfaces.

The optional [standalone admin dashboard](apps/dash/README.md) provides a compact dark-mode CRUD interface without direct database access. It talks to the server only through authenticated admin API routes and can be deployed separately.

<table>
<tr>
<td width="33%" valign="top">

### [Server](apps/server/README.md)

Elysia HTTP API, clean application services, Drizzle persistence, Redis sessions, migrations, and a standalone Docker image.

</td>
<td width="33%" valign="top">

### [Admin CLI](docs/cli-reference.md)

An operator interface bundled with the server image for direct administration from the container terminal.

</td>
<td width="33%" valign="top">

### [Client SDK](apps/sdk/README.md)

Typed license validation, automatic hardware identification, heartbeats, lifecycle events, and clean session release.

</td>
</tr>
</table>

### License models

| Model | Best for | Enforcement |
| --- | --- | --- |
| `PERPETUAL` | One-time purchases | Optional IP, hardware, concurrency, and trial limits |
| `SUBSCRIPTION` | Time-bound access | Required expiry plus optional registration limits |
| `USAGE` | Metered products | Balance consumed when a new session starts |

## Quick start

> [!IMPORTANT]
> Keyzori requires **Bun**, **PostgreSQL**, and **Redis**. Bun loads `.env` files automatically.

### 1. Configure and start

```powershell
Copy-Item apps/server/.env.example apps/server/.env
# Configure DATABASE_URL, REDIS_URL, and ADMIN_API_KEY.
bun run setup
bun run dev
```

The server applies pending Drizzle migrations during startup. Once running:

| URL | Purpose |
| --- | --- |
| [`http://localhost:3000/health`](http://localhost:3000/health) | Process liveness |
| [`http://localhost:3000/ready`](http://localhost:3000/ready) | PostgreSQL and Redis readiness |
| [`http://localhost:3000/docs`](http://localhost:3000/docs) | Interactive Scalar API reference |
| [`http://localhost:3000/docs/openapi.json`](http://localhost:3000/docs/openapi.json) | Generated OpenAPI document |

### 2. Create your first license

```powershell
bun run cli -- create-user --email owner@example.com --name "Example Owner"
bun run cli -- list-users
bun run cli -- create-key --user-id <USER_ID> --type PERPETUAL --limit-hwid 1
```

Give the returned `sk_...` secret and your deployed server URL to the application integrating the SDK.

> [!CAUTION]
> A full license secret is returned only when the key is created. Store it immediately and never place it in logs or source control.

### 3. Integrate the SDK

```typescript
import { LicenseClient } from "keyzori";

const license = new LicenseClient({
 apiKey: process.env.KEYZORI_LICENSE_KEY ?? "",
 serverUrl: "https://licenses.example.com",
 hardwareId: process.env.APP_MACHINE_ID,
});

const customFields = await license.initialize();
```

The optional application-specific `hardwareId` is trimmed, hashed with SHA-256, and never sent raw. Omitting it preserves the legacy automatic identifier. The returned object contains client-visible custom fields configured on that license. Customer custom fields are administrative metadata and are not sent to the SDK.

Continue with the [complete product flow](docs/product-flow.md) for heartbeats, logout, and revocation.

## Documentation

<table>
<tr>
<td valign="top">

**Learn**

- [Product flow](docs/product-flow.md)
- [Licensing model](docs/licensing-model.md)
- [Architecture](docs/architecture.md)
- [Handshake flow](docs/handshake-flow.md)

</td>
<td valign="top">

**Reference**

- [HTTP API](docs/api-reference.md)
- [Admin CLI](docs/cli-reference.md)
- [Client SDK](docs/sdk-reference.md)
- [Configuration](docs/configuration.md)

</td>
<td valign="top">

**Operate**

- [Deployment](docs/deployment.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Operations](docs/operations.md)

</td>
</tr>
</table>

Browse everything from the **[documentation hub](docs/README.md)**.

## Docker

The final image contains the compiled server and admin CLI executables, SQL migrations, and license notices—no separate Bun installation or `node_modules`. PostgreSQL and Redis can come from the local Compose stack or external production services.

```powershell
bun run docker:build
docker run --env-file apps/server/.env -p 3000:3000 keyzori-license-server
```

Run administrative commands inside the live container:

```powershell
docker exec keyzori-license-server keyzori-admin list-users
# Or, when using docker-compose.yml:
docker compose exec server keyzori-admin list-users
```

The connection URLs in `apps/server/.env` must be reachable from inside the container. See the [deployment guide](docs/deployment.md) before production use.

## Commands

<details>
<summary><strong>Development and validation</strong></summary>

| Command | Purpose |
| --- | --- |
| `bun run setup` | Install locked dependencies and apply migrations |
| `bun run dev` | Start the server in watch mode |
| `bun run build` | Build the server runtime and SDK |
| `bun run check` | Type-check, test, and lint everything |
| `bun run test:flow` | Test the cross-app flow with in-memory adapters |
| `bun run test:live` | Run the opt-in PostgreSQL/Redis lifecycle test |

</details>

<details>
<summary><strong>Server and database</strong></summary>

| Command | Purpose |
| --- | --- |
| `bun run dev:server` | Start the source server in watch mode |
| `bun run dev:dash` | Start the admin dashboard in watch mode |
| `bun run dash` | Start the admin dashboard |
| `bun run dev:server:binary` | Rebuild and start the compiled server |
| `bun run build:server` | Compile the server and admin CLI executables |
| `bun run server` | Run the existing compiled server |
| `bun run db:generate` | Generate a migration after a schema change |
| `bun run db:check` | Validate migration history |
| `bun run db:migrate` | Apply committed migrations |
| `bun run db:studio` | Open Drizzle Studio |
| `bun run docker:build` | Build the standalone server image |

</details>

<details>
<summary><strong>CLI and workspace tests</strong></summary>

| Command | Purpose |
| --- | --- |
| `bun run cli:help` | Show all CLI commands |
| `bun run cli -- <command>` | Run an administrator command |
| `bun run test:server` | Test the server workspace |
| `bun run test:cli` | Test the server's CLI delivery adapter |
| `bun run test:sdk` | Test the SDK workspace |
| `bun run test:dash` | Test the dashboard security boundary |

</details>

## Project status

Keyzori provides a self-hosted server, bundled administrator CLI, TypeScript SDK, database migrations, Docker deployment, and end-to-end documentation. Before serving real licenses, configure TLS, private dependency networking, backups, monitoring, and recovery using the [deployment](docs/deployment.md) and [operations](docs/operations.md) guides.

## Community, security, and license

[Contributing](CONTRIBUTING.md) · [Governance](GOVERNANCE.md) · [Support](https://tsukiyo.cc/join)

Licensed under the [Apache License 2.0](LICENSE).
