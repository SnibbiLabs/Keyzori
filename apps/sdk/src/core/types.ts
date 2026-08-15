/** Controls the amount of internal logging produced by {@link LicenseClient}. */
export type LogLevel = "none" | "error" | "warn" | "info" | "debug";

/** License behavior selected by the instance operator. */
export type LicenseType = "lifetime" | "subscription" | "metered" | "trial";

/** Stable server error identifiers used for licensing decisions. */
export type LicenseErrorCode =
	| "INVALID_REQUEST"
	| "RATE_LIMITED"
	| "LICENSE_INVALID"
	| "LICENSE_REVOKED"
	| "LICENSE_EXPIRED"
	| "IP_NOT_ALLOWED"
	| "DEVICE_NOT_ALLOWED"
	| "SESSION_INVALID_OR_EXPIRED"
	| "CONCURRENT_SESSION_LIMIT"
	| "METER_NOT_FOUND"
	| "METER_ARCHIVED"
	| "METER_EXHAUSTED"
	| "USAGE_EVENT_CONFLICT"
	| "IP_REGISTRATION_LIMIT"
	| "DEVICE_REGISTRATION_LIMIT"
	| "INTERNAL_ERROR";

/** A scalar JSON value. */
export type JsonPrimitive = string | number | boolean | null;

/** A recursively JSON-compatible value. */
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

/** Client-visible metadata configured on a license. */
export type JsonObject = { [key: string]: JsonValue };

/** Public result returned after activation or a successful heartbeat. */
export interface ActivationResult {
	licenseType: LicenseType;
	metadata: JsonObject;
}

/** Input accepted by {@link LicenseClient.consume}. */
export interface ConsumeInput {
	/** Immutable meter name configured by the instance operator. */
	meter: string;

	/** Positive, safe-integer number of units to consume. */
	units: number;

	/** Per-license idempotency identifier for this usage event. */
	eventId: string;
}

/** Successful named-meter consumption result. */
export interface UsageResult extends ConsumeInput {
	/** Balance remaining after the idempotent usage event. */
	remaining: number;
}

/** Successful `/v1/activate` response. */
export interface ActivateResponse extends ActivationResult {
	success: true;
	sessionToken: string;
	sessionTtlSeconds: number;
}

/** Successful `/v1/heartbeat` response. */
export type HeartbeatResponse = ActivateResponse;

/** Successful `/v1/usage` response. */
export interface UsageResponse extends UsageResult {
	success: true;
}

/** Successful `/v1/deactivate` response. */
export interface DeactivateResponse {
	success: true;
}

/** Structured error body returned by the licensing server. */
export interface LicenseErrorResponse {
	error: string;
	code?: LicenseErrorCode | (string & {});
}

/** Configuration for a {@link LicenseClient}. */
export interface LicenseClientConfig {
	/** Full license secret returned once by the instance operator. */
	licenseKey: string;

	/** Fully qualified URL of the Keyzori server. */
	serverUrl: string;

	/**
	 * Optional application-specific device identifier. Its trimmed value must
	 * contain 1-1024 characters and is transmitted only as a SHA-256 digest.
	 * When omitted, a stable identifier is derived from the host.
	 */
	deviceId?: string;

	/**
	 * Maximum interval between automatic heartbeats.
	 * @default 30000
	 */
	heartbeatIntervalMs?: number;

	/**
	 * Consecutive transient heartbeat failures allowed before going offline.
	 * @default 2
	 */
	maxRetries?: number;

	/**
	 * Maximum duration of an HTTP request in milliseconds.
	 * @default 10000
	 */
	requestTimeoutMs?: number;

	/** Internal logging level. */
	logLevel?: LogLevel;
}

/** Lifecycle events emitted by {@link LicenseClient}. */
export interface LicenseEventMap {
	/** Initial activation completed and automatic heartbeats started. */
	ready: (activation: ActivationResult) => void;

	/** A recurring heartbeat refreshed the session. */
	"heartbeat:success": (activation: ActivationResult) => void;

	/** A transient heartbeat failed but has not exhausted `maxRetries`. */
	"heartbeat:failed": (error: string, strikes: number) => void;

	/** A rate-limited heartbeat was rescheduled without a failure strike. */
	"heartbeat:throttled": (retryAfterMs: number) => void;

	/** The server reports that the license was revoked. */
	"license:revoked": (reason: string) => void;

	/** The server reports that the license has expired. */
	"license:expired": (reason: string) => void;

	/** The current server-issued session is no longer valid. */
	"session:expired": (reason: string) => void;

	/** Another license or usage policy rejected the request. */
	"license:rejected": (reason: string) => void;

	/** Consecutive transient heartbeat failures exhausted `maxRetries`. */
	"network:offline": (error: string) => void;
}

/** Typed event subscriptions exposed by {@link LicenseClient}. */
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
