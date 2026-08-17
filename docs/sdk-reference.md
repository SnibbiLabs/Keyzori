# SDK reference

`keyzori` integrates trusted Bun or Node.js desktop/server applications with a Keyzori instance. Licensed product users do not need operator API or CLI access. This is not a browser SDK because the license secret must remain private and device identification uses operating-system APIs.

## Requirements and installation

- Bun 1.3.14 or newer, or Node.js 18 or newer.
- An HTTPS Keyzori server URL. HTTP is accepted only for loopback development.
- A full `lic_...` license secret. Data migrations preserve existing `sk_...` secrets.

```powershell
bun add keyzori
```

The package is ESM and ships compiled JavaScript plus TypeScript declarations.

## Recommended integration

```typescript
import { LicenseClient, LicenseRequestError } from "keyzori";

const client = new LicenseClient({
	licenseKey: process.env.KEYZORI_LICENSE_KEY ?? "",
	serverUrl: "https://licenses.example.com",
	deviceId: process.env.KEYZORI_DEVICE_ID,
	heartbeatIntervalMs: 30_000,
	maxRetries: 2,
	requestTimeoutMs: 10_000,
	logLevel: "warn",
});

client.events.on("ready", ({ licenseType, metadata }) => {
	console.info("License ready", licenseType, metadata.tier);
});

client.events.on("license:expired", (reason) => {
	console.error("License expired", reason);
});

client.events.on("license:revoked", (reason) => {
	console.error("License revoked", reason);
});

client.events.on("license:rejected", (reason) => {
	console.error("License policy rejected", reason);
});

client.events.on("network:offline", (reason) => {
	console.error("License server unavailable", reason);
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

async function shutdown(): Promise<never> {
	await client.deactivate();
	process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
```

Attach event listeners before `activate()` so the initial `ready` event cannot be missed.

## Exports

Runtime exports:

- `LicenseClient`
- `LicenseRequestError`

Type exports:

- `LicenseClientConfig`, `ActivationResult`, `ConsumeInput`, and `UsageResult`
- `ActivateResponse`, `HeartbeatResponse`, `UsageResponse`, and `DeactivateResponse`
- `LicenseErrorResponse`, `LicenseErrorCode`, and `LicenseType`
- `LicenseEvents`, `LicenseEventMap`, and `LogLevel`
- `JsonObject`, `JsonValue`, and `JsonPrimitive`

Device identification, networking, response-size enforcement, and event dispatch remain internal implementation details.

## License types

```typescript
type LicenseType = "lifetime" | "subscription" | "metered" | "trial";
```

- `lifetime` has no type-level expiry or usage balance.
- `subscription` is valid through its configured expiry and may be managed manually or through Stripe.
- `metered` uses one or more named integer balances. Activation and heartbeats are free.
- `trial` begins on first activation and expires after its configured duration.

The latest type and client-visible metadata are returned by each heartbeat, so operator changes take effect without restarting the product.

## `LicenseClientConfig`

| Property | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `licenseKey` | `string` | Yes | - | Full license secret containing 1-128 trimmed characters. |
| `serverUrl` | `string` | Yes | - | HTTPS base URL; HTTP is restricted to `localhost`, `127.0.0.1`, or `[::1]`. |
| `deviceId` | `string` | No | Derived host ID | Application-specific identifier containing 1-1024 trimmed characters. Only its SHA-256 digest is transmitted. |
| `heartbeatIntervalMs` | `number` | No | `30000` | Maximum delay after a completed heartbeat, clamped to two-thirds of the server session TTL. |
| `maxRetries` | `number` | No | `2` | Consecutive retryable heartbeat failures before `network:offline`. |
| `requestTimeoutMs` | `number` | No | `10000` | Timeout applied to every licensing request. |
| `logLevel` | `LogLevel` | No | `none` | Internal logging threshold. |

All numeric configuration values must be positive safe integers no greater than `2147483647`.

`LogLevel` is `"none" | "error" | "warn" | "info" | "debug"`. `none` silences all SDK logging.

## `LicenseClient`

### Constructor

```typescript
new LicenseClient(config: LicenseClientConfig)
```

The constructor validates configuration, normalizes the server URL, and prepares a stable device digest. It does not contact the server.

### `events`

```typescript
readonly events: LicenseEvents
```

Register lifecycle listeners through this typed broker.

### `activate()`

```typescript
activate(): Promise<ActivationResult>

interface ActivationResult {
	licenseType: LicenseType;
	metadata: JsonObject;
}
```

Activation validates the license and device policy, creates a server session, emits `ready`, and starts automatic heartbeats. The opaque session token stays private to the client.

Concurrent activation calls share one request. Calls made while active return the latest activation result without creating another session or heartbeat loop. A failed activation can be retried; a deactivated client is terminal and rejects later activation attempts.

`metadata` is the client-visible JSON object configured on the license. Customer metadata is operator-only and is never included in runtime responses. Values may be strings, numbers, booleans, `null`, arrays, or nested objects.

### `consume()`

```typescript
consume(input: ConsumeInput): Promise<UsageResult>

interface ConsumeInput {
	meter: string;
	units: number;
	eventId: string;
}

interface UsageResult extends ConsumeInput {
	remaining: number;
}
```

`consume()` requires an active session. `meter` and `eventId` are trimmed and must contain 1-128 characters. `units` must be a positive safe integer no greater than `2147483647`.

`eventId` is idempotent per license. Use the same ID when retrying the same logical action. An identical retry returns the original result; reusing an ID with different meter or unit values is rejected.

```typescript
import { randomUUID } from "node:crypto";

const result = await client.consume({
	meter: "exports",
	units: 1,
	eventId: randomUUID(),
});

console.info(`${result.remaining} export units remain`);
```

Meter configuration errors and exhausted balances reject only the usage request. License revocation, expiry, device/IP denial, or session expiry also begins terminal client cleanup.

### `deactivate()`

```typescript
deactivate(): Promise<void>
```

Deactivation stops future heartbeats, waits for current licensing requests, releases the server session, removes event listeners, and makes the client terminal. Repeated calls return the same promise and never send duplicate requests.

If session release fails, local cleanup still completes and the promise rejects with the failure. The server session TTL remains the fallback after crashes or unreachable-server shutdowns.

## Events

| Event | Listener arguments | When emitted |
| --- | --- | --- |
| `ready` | `(activation)` | Exactly once after initial activation succeeds. |
| `heartbeat:success` | `(activation)` | The session was refreshed; receives the latest type and metadata. |
| `heartbeat:failed` | `(error, strikes)` | A retryable heartbeat failed. It also fires on the final strike. |
| `heartbeat:throttled` | `(retryAfterMs)` | A `429` delayed the next heartbeat without consuming a failure strike. |
| `license:expired` | `(reason)` | The license effective status is expired. |
| `license:revoked` | `(reason)` | The license effective status is revoked. |
| `session:expired` | `(reason)` | The server session is invalid or expired. |
| `license:rejected` | `(reason)` | Another license, access, or meter policy rejected a request. |
| `network:offline` | `(error)` | Consecutive retryable heartbeat failures reached `maxRetries`. |

Fatal license/session events and `network:offline` trigger automatic deactivation. Successful heartbeats reset the failure count. A new heartbeat is scheduled only after the prior one finishes.

Consumer listener exceptions are contained and reported at `warn` level so they cannot interrupt license enforcement or prevent other listeners from running.

The event broker supports:

```typescript
on<K>(event: K, listener: LicenseEventMap[K]): void
once<K>(event: K, listener: LicenseEventMap[K]): void
removeListener<K>(event: K, listener: LicenseEventMap[K]): void
```

Pass the same function reference when removing a listener.

## HTTP contract

The high-level client uses four JSON endpoints:

| Endpoint | Request | Successful response |
| --- | --- | --- |
| `POST /v1/activate` | `{ licenseKey, deviceId }` | `{ success, licenseType, metadata, sessionToken, sessionTtlSeconds }` |
| `POST /v1/heartbeat` | `{ sessionToken, deviceId }` | `{ success, licenseType, metadata, sessionToken, sessionTtlSeconds }` |
| `POST /v1/usage` | `{ sessionToken, deviceId, meter, units, eventId }` | `{ success, meter, units, eventId, remaining }` |
| `POST /v1/deactivate` | `{ sessionToken, deviceId }` | `{ success }` |

The full license secret is sent only during activation. Every later request uses the opaque session token and device digest.

## Errors

Non-success HTTP responses throw `LicenseRequestError`:

```typescript
class LicenseRequestError extends Error {
	readonly status: number;
	readonly code?: LicenseErrorCode | string;
}
```

Stable `LicenseErrorCode` values are:

- `INVALID_REQUEST`, `RATE_LIMITED`, and `INTERNAL_ERROR`
- `LICENSE_INVALID`, `LICENSE_REVOKED`, and `LICENSE_EXPIRED`
- `IP_NOT_ALLOWED`, `DEVICE_NOT_ALLOWED`, `IP_REGISTRATION_LIMIT`, and `DEVICE_REGISTRATION_LIMIT`
- `SESSION_INVALID_OR_EXPIRED` and `CONCURRENT_SESSION_LIMIT`
- `METER_NOT_FOUND`, `METER_ARCHIVED`, `METER_EXHAUSTED`, and `USAGE_EVENT_CONFLICT`

Network failures, timeouts, malformed responses, oversized responses, and response/request mismatches throw standard `Error` instances.

## Runtime and security considerations

- Treat `licenseKey` and `sessionToken` as credentials. The SDK never exposes the session token through its high-level methods or events.
- Use HTTPS outside loopback development; remote cleartext URLs are rejected.
- Fetch redirect mode is `error`, so redirects cannot forward credentials or request bodies to another origin.
- Each response body is limited to 256 KiB before parsing. Successful payloads, session TTLs, meter values, and echoed usage identifiers are validated.
- An explicit `deviceId` is trimmed and SHA-256 hashed. Without one, the SDK derives a digest from host OS and network-adapter properties; substantial host changes can register a new device.
- Device-side licensing can be modified by users who control the host. Use server-side authorization for high-value operations.
- License metadata is visible to the licensed application and must not contain secrets.
- Await `deactivate()` during orderly shutdown, while relying on the server TTL after crashes.

Bun standalone executables are release-tested with `bun build --compile`. The compiled fixture imports the built package and exercises activation, automatic heartbeat refresh, named-meter consumption, deactivation, token reuse, key omission after activation, device hashing, and redirect refusal.
