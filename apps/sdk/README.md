<div align="center">

# `keyzori`

**Typed license validation for Bun and Node.js applications.**

[`Project`](../../README.md) · [`Full SDK reference`](../../docs/sdk-reference.md) · [`Handshake flow`](../../docs/handshake-flow.md)

</div>

---

The Keyzori SDK manages initial validation, hardware identification, session heartbeats, lifecycle events, and clean logout for desktop and server applications.

> [!NOTE]
> This is not a browser SDK. Hardware identification relies on operating-system APIs and the license secret must remain in a trusted runtime.

## Install

```powershell
bun add keyzori
```

Local workspace development is linked automatically by `bun install`.

## Quick start

```typescript
import { LicenseClient } from "keyzori";

const client = new LicenseClient({
	apiKey: process.env.KEYZORI_LICENSE_KEY ?? "",
	serverUrl: "https://licenses.example.com",
	hardwareId: process.env.APP_MACHINE_ID,
	heartbeatIntervalMs: 30_000,
	maxRetries: 3,
	requestTimeoutMs: 10_000,
});

client.events.on("ready", (customFields) => {
	console.info("License tier", customFields.tier);
});

client.events.on("license:revoked", (reason) => {
	console.error(reason);
	process.exit(1);
});

await client.initialize();

process.once("SIGINT", async () => {
	await client.destroy();
	process.exit(0);
});
```

Attach event listeners before `initialize()` so the initial `ready` event cannot be missed.

`initialize()` returns the license's client-visible `JsonObject` custom fields. These are separate from administrative customer custom fields, which the server never sends through a handshake. Do not place secrets in either metadata object.

## Lifecycle at a glance

```text
new client → initialize → validate → active heartbeat loop → destroy → session released
                             │
                             └─ rejected / expired / offline → event emitted
```

| Method | Behavior |
| --- | --- |
| `initialize()` | Validates the license, emits `ready`, and starts heartbeats |
| `initialize()` while active | Returns the original custom fields without another heartbeat loop |
| `destroy()` | Stops heartbeats and releases the concurrent session |
| repeated `destroy()` | Safe; no duplicate cleanup is performed |

Requests have a timeout and heartbeats never overlap.

The package's only runtime export is `LicenseClient`. Type-only exports include `LicenseClientConfig`, lifecycle event types, key/log-level unions, and the recursive `JsonObject`, `JsonValue`, and `JsonPrimitive` types.

Remote server URLs must use HTTPS; loopback HTTP remains available for local development. Success and error responses are bounded internally. Consumer event-listener exceptions are contained so they cannot interrupt license-state enforcement.

## Events

| Event | When it fires |
| --- | --- |
| `ready` | Initial validation succeeded; receives custom fields |
| `heartbeat:success` | The session TTL was refreshed |
| `heartbeat:failed` | A retryable HTTP or network failure occurred |
| `heartbeat:throttled` | A `429` delayed the next heartbeat without adding a failure strike |
| `license:revoked` | The server rejected the license |
| `license:expired` | A trial or subscription expired |
| `session:expired` | The server-issued session is no longer valid |
| `license:rejected` | Another license policy rejected the runtime |
| `network:offline` | Consecutive failures reached `maxRetries` |

> [!WARNING]
> Without `hardwareId`, the legacy SHA-256 identifier is derived from host OS and network-adapter properties. Significant hardware or network changes can register a new device. Applications can instead provide a stable, application-specific identifier; only its SHA-256 digest is transmitted.

## Build, test, and publish

```powershell
bun run --cwd apps/sdk build
bun run --cwd apps/sdk test
bun run test:sdk:compiled
bun run publish:sdk
```

The published package contains compiled ESM JavaScript and TypeScript declarations from `dist/`; source and tests are not shipped. CI also compiles and runs a downstream Bun standalone executable against local test servers.

See the [complete SDK reference](../../docs/sdk-reference.md) for every export, configuration default, method, event, lifecycle guarantee, and error behavior.
