<div align="center">

# `keyzori`

**Typed license activation for Bun and Node.js applications.**

[`Project`](../../README.md) | [`Full SDK reference`](../../docs/sdk-reference.md) | [`API reference`](../../docs/api-reference.md)

</div>

---

The Keyzori SDK activates a license, manages its device-bound session, sends automatic heartbeats, records named-meter usage, and releases the session cleanly.

> [!NOTE]
> This is not a browser SDK. Keep the license secret in a trusted desktop or server runtime. Licensed product users do not need access to Keyzori's operator API or CLI.

## Install

```powershell
bun add keyzori
```

## Quick start

```typescript
import { LicenseClient, LicenseRequestError } from "keyzori";

const client = new LicenseClient({
	licenseKey: process.env.KEYZORI_LICENSE_KEY ?? "",
	serverUrl: "https://licenses.example.com",
	deviceId: process.env.KEYZORI_DEVICE_ID,
	heartbeatIntervalMs: 30_000,
	maxRetries: 3,
	requestTimeoutMs: 10_000,
});

client.events.on("ready", ({ licenseType, metadata }) => {
	console.info("License ready", licenseType, metadata.tier);
});

client.events.on("license:revoked", (reason) => {
	console.error(reason);
	process.exit(1);
});

try {
	const activation = await client.activate();
	console.info("Activated", activation.licenseType);
} catch (error) {
	if (error instanceof LicenseRequestError) {
		console.error(error.status, error.code, error.message);
	}
	throw error;
}

process.once("SIGINT", async () => {
	await client.deactivate();
	process.exit(0);
});
```

Attach event listeners before `activate()` so the initial `ready` event cannot be missed.

## Public methods

| Method | Behavior |
| --- | --- |
| `activate()` | Starts a session and returns `{ licenseType, metadata }` |
| repeated `activate()` | Returns the current activation result without starting another session |
| `consume({ meter, units, eventId })` | Atomically consumes a positive number of named-meter units |
| `deactivate()` | Stops heartbeats and releases the session; repeated calls share the same result |

`consume()` requires an active session. `eventId` is a per-license idempotency key: retry the same logical action with the same ID. The server returns the original result for an identical retry and rejects conflicting reuse.

```typescript
const usage = await client.consume({
	meter: "exports",
	units: 1,
	eventId: crypto.randomUUID(),
});

console.info(`${usage.remaining} export units remain`);
```

Activation and heartbeats do not consume meter balances. Only explicit `consume()` calls do.

## Session and security behavior

```text
new client -> activate -> automatic heartbeat loop -> deactivate -> released
                    |                 |
                    |                 +-> refreshed type and metadata
                    +-> consume named-meter usage
```

The full `licenseKey` is sent only to `POST /v1/activate`. The server-issued `sessionToken` and hashed `deviceId` are used for heartbeat, usage, and deactivation requests. Session tokens are kept inside the client.

Remote server URLs must use HTTPS. Loopback HTTP is allowed for local development. Redirects are refused, requests time out, response bodies are capped at 256 KiB, and success bodies are validated before use. Automatic heartbeats never overlap. The SDK tracks the server-issued session TTL and clamps transient-error and `Retry-After` retries so they are attempted before the current session expires. Repeated throttling is bounded and cannot create a tight retry loop.

If `deviceId` is supplied, its trimmed value is SHA-256 hashed before transmission. When omitted, the SDK derives a stable digest from host operating-system and network-adapter properties. A substantial host or network change can therefore register a new device.

## License types

`LicenseType` is the lowercase union:

```typescript
type LicenseType = "lifetime" | "subscription" | "metered" | "trial";
```

Heartbeat results refresh the current `licenseType` and client-visible `metadata`, so operator changes take effect without restarting the product.

## Events

| Event | When it fires |
| --- | --- |
| `ready` | Initial activation succeeded; receives the activation result |
| `heartbeat:success` | Session refreshed; receives the latest activation result |
| `heartbeat:failed` | A retryable HTTP or network failure occurred |
| `heartbeat:throttled` | A `429` delayed the next heartbeat without a failure strike |
| `license:revoked` | The license was revoked |
| `license:expired` | A subscription or trial expired |
| `session:expired` | The server-issued session is invalid or expired |
| `license:rejected` | Another license or meter policy rejected a request |
| `network:offline` | Consecutive heartbeat failures reached `maxRetries` |

Consumer event-listener exceptions are contained so they cannot interrupt license enforcement.

## Errors and types

Non-success HTTP responses throw `LicenseRequestError`, which exposes the safe server `message`, HTTP `status`, and optional stable `code`. Network failures and invalid server responses throw standard `Error` instances.

Runtime exports are `LicenseClient` and `LicenseRequestError`. Type exports include request and result types, wire response types, event types, `LicenseType`, `LicenseErrorCode`, `LicenseClientConfig`, and recursive JSON metadata types.

## Build and test

```powershell
bun run --cwd apps/sdk typecheck
bun run --cwd apps/sdk test
bun run --cwd apps/sdk build
```

The package ships compiled ESM JavaScript and TypeScript declarations from `dist/`.
