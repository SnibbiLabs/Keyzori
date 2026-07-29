# SDK reference

`keyzori` integrates Bun or Node.js desktop/server applications with a Keyzori server. It is not a browser SDK because hardware identification uses operating-system APIs.

## Requirements and installation

- Bun 1.3.14 or newer, or Node.js 18 or newer.
- An HTTPS Keyzori server URL (HTTP is accepted only for loopback development).
- A full `sk_...` secret returned when an administrator creates a license.

```powershell
bun add keyzori
```

The package is ESM and exports compiled JavaScript plus TypeScript declarations.

## Recommended integration

```typescript
import { LicenseClient } from "keyzori";

const client = new LicenseClient({
	apiKey: process.env.KEYZORI_LICENSE_KEY ?? "",
	serverUrl: "https://licenses.example.com",
	hardwareId: process.env.APP_MACHINE_ID,
	heartbeatIntervalMs: 30_000,
	maxRetries: 2,
	requestTimeoutMs: 10_000,
	logLevel: "warn",
});

client.events.on("ready", (customFields) => {
	console.info("License tier", customFields.tier);
});

client.events.on("license:expired", (reason) => {
	console.error("License expired", reason);
});

client.events.on("license:revoked", (reason) => {
	console.error("License rejected", reason);
});

client.events.on("license:rejected", (reason) => {
	console.error("License policy rejected", reason);
});

client.events.on("network:offline", (reason) => {
	console.error("License server unavailable", reason);
});

const customFields = await client.initialize();

async function shutdown(): Promise<never> {
	await client.destroy();
	process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
```

Attach event listeners before `initialize()` so the initial `ready` event cannot be missed.

## Exports

The package exports:

- `LicenseClient` — the public runtime API.
- `LicenseClientConfig`, `LicenseEvents`, `LicenseEventMap`, `LicenseErrorCode`, `KeyType`, `LogLevel`, `JsonObject`, `JsonValue`, and `JsonPrimitive` TypeScript types.

Hardware identification, networking, response-size limits, and event dispatch are internal implementation details and are not public package exports.

## `LicenseClientConfig`

| Property | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `apiKey` | `string` | Yes | — | Full license secret. Blank strings are rejected. |
| `serverUrl` | `string` | Yes | — | HTTPS base URL; HTTP is restricted to `localhost`, `127.0.0.1`, or `[::1]`. |
| `hardwareId` | `string` | No | Automatic legacy ID | Application-specific identifier containing 1–1024 trimmed characters. Only its SHA-256 digest is transmitted. |
| `heartbeatIntervalMs` | `number` | No | `30000` | Requested maximum delay after a completed heartbeat. It is clamped to two-thirds of the server-advertised session TTL. |
| `maxRetries` | `number` | No | `2` | Consecutive retryable heartbeat failures before `network:offline`. Positive integer. |
| `requestTimeoutMs` | `number` | No | `10000` | Timeout applied to handshake and logout requests. Positive integer. |
| `logLevel` | `LogLevel` | No | `none` | Internal informational logging threshold. |

`LogLevel` is `"none" | "error" | "warn" | "info" | "debug"`. `none` silences all SDK logging, including fatal messages.

## `LicenseClient`

### Constructor

```typescript
new LicenseClient(config: LicenseClientConfig)
```

The constructor validates configuration and creates the hardware and network helpers. The server issues an opaque token during the first successful handshake, binds it to the admission IP/HWID context, and the SDK reuses it with the same HWID for heartbeats and logout.

### `events`

```typescript
readonly events: LicenseEvents
```

Register lifecycle listeners through this broker.

### `initialize()`

```typescript
initialize(): Promise<JsonObject>
```

Performs the first handshake. On success it:

1. validates the server response shape;
2. stores and returns `customFields`;
3. changes state to active;
4. emits `ready`;
5. schedules the heartbeat loop.

Concurrent calls share one initialization promise. Calls made while already active return the original custom fields without creating another loop.

`customFields` is the client-visible JSON object configured on the license itself. Customer-level custom fields are operator metadata and are never included in handshake or SDK responses. Values may be strings, numbers, booleans, `null`, arrays, or nested objects.

```typescript
import type { JsonObject } from "keyzori";

const fields: JsonObject = await client.initialize();
```

An unsuccessful initial handshake rejects with an `Error`, emits the matching policy event when identifiable, logs according to `logLevel`, and destroys the client. A failed/destroyed instance cannot be reinitialized; create a new `LicenseClient` if retry policy requires a fresh session.

Typical initial error messages include:

- `License Block: Invalid or revoked API key`
- `License Block: Subscription expired`
- `License Block: Maximum concurrent sessions reached`
- `License server returned an invalid handshake response`
- request timeout or network errors from `fetch`

### `destroy()`

```typescript
destroy(): Promise<void>
```

Stops future heartbeats, sends one best-effort logout request, and removes every registered listener. It is idempotent: repeated calls return the same destruction promise.

If logout fails, destruction still completes. With `logLevel` at `warn` or above, the SDK reports that the session could not be released; Redis expiry remains the fallback.

## Events

| Event | Listener arguments | When emitted |
| --- | --- | --- |
| `ready` | `(customFields)` | Exactly once after initial validation succeeds. |
| `heartbeat:success` | `()` | A recurring handshake succeeds and its response is valid. |
| `heartbeat:failed` | `(error, strikes)` | A retryable heartbeat fails. It also fires on the final strike. |
| `heartbeat:throttled` | `(retryAfterMs)` | A `429` delays the next heartbeat according to `Retry-After` without consuming a failure strike. |
| `license:expired` | `(reason)` | A trial or subscription expiry code is returned. |
| `license:revoked` | `(reason)` | The license is invalid or revoked. |
| `session:expired` | `(reason)` | The server-issued session is invalid or expired. |
| `license:rejected` | `(reason)` | Another whitelist, concurrency, usage, IP, or HWID policy rejects the runtime. |
| `network:offline` | `(error)` | Consecutive retryable failures reach `maxRetries`. |

After a fatal license event or `network:offline`, the client destroys itself. New servers provide stable error codes; the SDK retains message-based classification for older servers.

Successful heartbeats reset the consecutive-failure count to zero. Heartbeats are scheduled only after the previous request finishes, so a slow request cannot overlap the next one.

## Event subscriptions

The `client.events` property implements `LicenseEvents`:

```typescript
on<K>(event: K, listener: LicenseEventMap[K]): void
once<K>(event: K, listener: LicenseEventMap[K]): void
removeListener<K>(event: K, listener: LicenseEventMap[K]): void
```

Event emission and bulk listener cleanup are internal. `destroy()` removes registered listeners after its logout attempt finishes.

Consumer listener exceptions are contained and reported at `warn` level so they cannot interrupt license-state enforcement or prevent other listeners from running.

When removing a listener, pass the same function reference used during registration:

```typescript
const onHeartbeat = () => console.info("still licensed");
client.events.on("heartbeat:success", onHeartbeat);
client.events.removeListener("heartbeat:success", onHeartbeat);
```

## Runtime and security considerations

- Treat the full license key as a credential. Do not log or embed it in public source.
- Use HTTPS outside loopback development; the SDK rejects remote cleartext URLs.
- Handshake and logout requests use Fetch redirect mode `error`, so 307/308 responses cannot forward the license secret or body to another origin.
- The SDK performs policy enforcement in application code; determined users controlling the host may modify that application. Combine licensing with server-side authorization for high-value operations.
- License `customFields` are visible to every application holding the license secret and must not contain secrets. Customer custom fields remain administrative-only.
- Ensure application shutdown awaits `destroy()` when possible, while still relying on the 45-second server TTL after crashes.
- Bun standalone executables are release-tested with `bun build --compile`; the compiled fixture imports the built `keyzori` package export and exercises initialization, heartbeat, token reuse, logout, and redirect refusal.
