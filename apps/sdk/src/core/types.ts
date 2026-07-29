/**
 * Defines the strictness level of the logging output by the LicenseClient.
 * - `none`: Silences all logs.
 * - `error`: Only logs errors.
 * - `warn`: Logs warnings and errors.
 * - `info`: Standard lifecycle logs.
 * - `debug`: Verbose logs for deep troubleshooting.
 */
export type LogLevel = "none" | "error" | "warn" | "info" | "debug";

/** License type returned by the server after validation. */
export type KeyType = "PERPETUAL" | "SUBSCRIPTION" | "USAGE";

/** Stable server error identifiers used for runtime licensing decisions. */
export type LicenseErrorCode =
	| "LICENSE_INVALID_OR_REVOKED"
	| "IP_NOT_WHITELISTED"
	| "HWID_NOT_WHITELISTED"
	| "TRIAL_EXPIRED"
	| "SUBSCRIPTION_EXPIRED"
	| "SESSION_INVALID_OR_EXPIRED"
	| "CONCURRENT_SESSION_LIMIT"
	| "USAGE_EXHAUSTED"
	| "IP_REGISTRATION_LIMIT"
	| "HWID_REGISTRATION_LIMIT";

/** A scalar value accepted in license custom fields. */
export type JsonPrimitive = string | number | boolean | null;

/** Any JSON-compatible value accepted in license custom fields. */
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

/** Client-visible JSON metadata configured on a license. */
export type JsonObject = { [key: string]: JsonValue };

/**
 * Configuration options for initializing the Keyzori LicenseClient.
 */
export interface LicenseClientConfig {
	/**
	 * The unique API Key issued to the user for this application.
	 */
	apiKey: string;

	/**
	 * The fully qualified URL of the Keyzori Licensing Server.
	 */
	serverUrl: string;

	/**
	 * Optional application-specific machine identifier. The trimmed value must
	 * contain 1–1024 characters and is transmitted only as a SHA-256 digest.
	 * When omitted, the legacy automatic hardware identifier is used unchanged.
	 */
	hardwareId?: string;

	/**
	 * Interval in milliseconds between successive heartbeat/handshake requests.
	 * @default 30000 (30 seconds)
	 */
	heartbeatIntervalMs?: number;

	/**
	 * The number of consecutive failed heartbeats allowed before the client forcefully closes.
	 * @default 2
	 */
	maxRetries?: number;

	/**
	 * Maximum duration in milliseconds for each handshake or logout request.
	 * @default 10000 (10 seconds)
	 */
	requestTimeoutMs?: number;

	/**
	 * Logging level for the client's internal output.
	 * @default "none"
	 */
	logLevel?: LogLevel;
}

/**
 * A mapping of all lifecycle events emitted by LicenseClient.
 * You can subscribe to these using `client.events.on('eventName', callback)`.
 */
export interface LicenseEventMap {
	/**
	 * Emitted exactly once when the initial handshake completes successfully.
	 * @param customFields - Client-visible JSON metadata attached to the license.
	 */
	ready: (customFields: JsonObject) => void;

	/**
	 * Emitted every time a recurring heartbeat completes successfully.
	 */
	"heartbeat:success": () => void;

	/**
	 * Emitted when a heartbeat fails but has not yet exceeded `maxRetries`.
	 * @param error - The HTTP or network error message.
	 * @param strikes - The current number of consecutive failures.
	 */
	"heartbeat:failed": (error: string, strikes: number) => void;

	/**
	 * Emitted when the server rate limits a heartbeat. Throttling does not count
	 * as a failed-heartbeat strike.
	 * @param retryAfterMs - Delay selected from the Retry-After response header.
	 */
	"heartbeat:throttled": (retryAfterMs: number) => void;

	/**
	 * Emitted if the server explicitly rejects the license due to revocation or admin action.
	 * @param reason - Server provided reason for revocation.
	 */
	"license:revoked": (reason: string) => void;

	/**
	 * Emitted if a Trial or Subscription period has expired.
	 * @param reason - Server provided explanation for the expiration.
	 */
	"license:expired": (reason: string) => void;

	/** Emitted when the current server-side session has expired. */
	"session:expired": (reason: string) => void;

	/** Emitted for a runtime policy rejection that is not expiry or revocation. */
	"license:rejected": (reason: string) => void;

	/**
	 * Emitted when consecutive heartbeat failures exceed `maxRetries`.
	 * The client will forcefully destroy itself immediately after this event.
	 * @param error - The final network error that caused the disconnection.
	 */
	"network:offline": (error: string) => void;
}

/** Lifecycle event subscriptions exposed by LicenseClient. */
export interface LicenseEvents {
	on<K extends keyof LicenseEventMap>(
		event: K,
		listener: LicenseEventMap[K],
	): void;
	once<K extends keyof LicenseEventMap>(
		event: K,
		listener: LicenseEventMap[K],
	): void;
	removeListener<K extends keyof LicenseEventMap>(
		event: K,
		listener: LicenseEventMap[K],
	): void;
}
