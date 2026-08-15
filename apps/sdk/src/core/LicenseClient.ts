import { DeviceManager } from "./DeviceManager";
import { EventBroker } from "./EventBroker";
import { LicenseRequestError } from "./LicenseRequestError";
import { NetworkClient } from "./NetworkClient";
import type {
	ActivateResponse,
	ActivationResult,
	ConsumeInput,
	DeactivateResponse,
	JsonObject,
	LicenseClientConfig,
	LicenseErrorCode,
	LicenseEvents,
	LicenseType,
	LogLevel,
	UsageResponse,
	UsageResult,
} from "./types";

const MAX_RESPONSE_BODY_BYTES = 262_144;
const MAX_SESSION_TTL_SECONDS = 86_400;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_LICENSE_KEY_LENGTH = 128;
const MAX_SESSION_TOKEN_LENGTH = 512;
const MAX_METER_NAME_LENGTH = 128;
const MAX_EVENT_ID_LENGTH = 128;
const MAX_LICENSE_LIMIT = 2_147_483_647;
const MIN_THROTTLED_RETRY_MS = 1_000;

type ClientState =
	| "idle"
	| "activating"
	| "active"
	| "deactivating"
	| "deactivated";

interface ServerRejection {
	message: string;
	code?: string;
}

const LOG_LEVELS: Record<LogLevel, number> = {
	none: 0,
	error: 1,
	warn: 2,
	info: 3,
	debug: 4,
};

/** Manages license activation, usage, session tracking, and heartbeats. */
export class LicenseClient {
	public readonly events: LicenseEvents;

	private readonly device: DeviceManager;
	private readonly network: NetworkClient;
	private readonly eventBroker: EventBroker;
	private readonly requestedHeartbeatIntervalMs: number;
	private readonly requestTimeoutMs: number;
	private readonly maxRetries: number;
	private readonly logLevel: LogLevel;
	private readonly usageRequests = new Set<Promise<UsageResult>>();
	private heartbeatIntervalMs: number;
	private heartbeatTimer?: ReturnType<typeof setTimeout>;
	private heartbeatRequest?: Promise<void>;
	private activation?: Promise<ActivationResult>;
	private deactivation?: Promise<void>;
	private activationResult?: ActivationResult;
	private sessionToken?: string;
	private sessionExpiresAtMs?: number;
	private state: ClientState = "idle";
	private failureStrikes = 0;
	private throttleRetries = 0;
	private expiryProtectedThrottleRetryUsed = false;
	private fatalCleanupScheduled = false;

	constructor(config: LicenseClientConfig) {
		this.assertConfig(config);
		this.logLevel = config.logLevel ?? "none";
		this.eventBroker = new EventBroker(() => {
			this.log("warn", "A license event listener threw an error");
		});
		this.events = this.eventBroker;
		this.device = new DeviceManager(config.deviceId);
		this.requestTimeoutMs = config.requestTimeoutMs ?? 10_000;
		this.network = new NetworkClient(
			config.serverUrl,
			config.licenseKey.trim(),
			this.requestTimeoutMs,
		);
		this.requestedHeartbeatIntervalMs = config.heartbeatIntervalMs ?? 30_000;
		this.heartbeatIntervalMs = this.requestedHeartbeatIntervalMs;
		this.maxRetries = config.maxRetries ?? 2;
	}

	/** Activates the license once and starts automatic heartbeats. */
	public activate(): Promise<ActivationResult> {
		if (this.state === "deactivating" || this.state === "deactivated") {
			return Promise.reject(new Error("LicenseClient has been deactivated"));
		}
		if (this.state === "active" && this.activationResult) {
			return Promise.resolve(this.activationResult);
		}
		if (this.activation) return this.activation;

		this.state = "activating";
		const activation = this.activateOnce();
		this.activation = activation;
		void activation.catch(() => {
			if (this.activation === activation && this.state === "idle") {
				this.activation = undefined;
			}
		});
		return activation;
	}

	/** Consumes units from a named meter using a per-license idempotency ID. */
	public async consume(input: ConsumeInput): Promise<UsageResult> {
		if (this.state !== "active" || !this.sessionToken) {
			throw new Error("LicenseClient is not active; call activate() first");
		}
		const normalized = this.normalizeConsumeInput(input);
		const request = this.consumeOnce(this.sessionToken, normalized);
		this.usageRequests.add(request);
		try {
			return await request;
		} finally {
			this.usageRequests.delete(request);
		}
	}

	/** Stops heartbeats and releases the server-side session. Safe to call twice. */
	public deactivate(): Promise<void> {
		if (this.deactivation) return this.deactivation;
		this.state = "deactivating";
		this.clearHeartbeatTimer();
		this.deactivation = this.deactivateOnce();
		return this.deactivation;
	}

	private async activateOnce(): Promise<ActivationResult> {
		try {
			const requestStartedAtMs = Date.now();
			const response = await this.network.sendActivate(
				this.device.getDeviceId(),
			);
			if (!response.ok) {
				const rejection = await this.readError(response);
				this.emitLicenseRejection(rejection);
				throw this.toRequestError(response, rejection);
			}

			const payload = await this.readSessionResponse(response, "activation");
			this.sessionToken = payload.sessionToken;
			this.sessionExpiresAtMs =
				requestStartedAtMs + payload.sessionTtlSeconds * 1_000;
			this.activationResult = this.toActivationResult(payload);
			this.heartbeatIntervalMs = this.clampHeartbeatInterval(
				payload.sessionTtlSeconds,
			);

			if (this.state !== "activating") {
				throw new Error("LicenseClient was deactivated during activation");
			}

			this.state = "active";
			this.eventBroker.emit("ready", this.activationResult);
			this.log("info", `License activated as ${payload.licenseType}`);
			this.scheduleHeartbeat();
			return this.activationResult;
		} catch (error) {
			if (this.state === "activating") this.state = "idle";
			throw error;
		}
	}

	private async consumeOnce(
		sessionToken: string,
		input: ConsumeInput,
	): Promise<UsageResult> {
		const response = await this.network.sendUsage(
			sessionToken,
			this.device.getDeviceId(),
			input,
		);
		if (!response.ok) {
			const rejection = await this.readError(response);
			this.emitLicenseRejection(rejection);
			if (this.isFatalSessionRejection(rejection.code)) {
				this.handleFatalError(rejection.message);
			}
			throw this.toRequestError(response, rejection);
		}

		const payload = await this.readUsageResponse(response);
		if (
			payload.meter !== input.meter ||
			payload.units !== input.units ||
			payload.eventId !== input.eventId
		) {
			throw new Error("License server returned a mismatched usage response");
		}
		return {
			meter: payload.meter,
			units: payload.units,
			eventId: payload.eventId,
			remaining: payload.remaining,
		};
	}

	private async deactivateOnce(): Promise<void> {
		let failure: unknown;
		try {
			await this.activation?.catch(() => undefined);
			await this.heartbeatRequest;
			await Promise.allSettled([...this.usageRequests]);

			if (this.sessionToken) {
				const response = await this.network.sendDeactivate(
					this.sessionToken,
					this.device.getDeviceId(),
				);
				if (!response.ok) {
					const rejection = await this.readError(response);
					throw this.toRequestError(response, rejection);
				}
				await this.readDeactivateResponse(response);
			}
		} catch (error) {
			failure = error;
			this.log("warn", "Could not release the license session");
		} finally {
			this.sessionToken = undefined;
			this.sessionExpiresAtMs = undefined;
			this.state = "deactivated";
			this.eventBroker.removeAllListeners();
		}

		if (failure) throw failure;
	}

	private scheduleHeartbeat(delayMs = this.heartbeatIntervalMs): void {
		if (this.state !== "active") return;
		this.heartbeatTimer = setTimeout(() => {
			const request = this.runHeartbeat();
			this.heartbeatRequest = request;
			void request.finally(() => {
				if (this.heartbeatRequest === request) {
					this.heartbeatRequest = undefined;
				}
			});
		}, delayMs);
		this.heartbeatTimer.unref();
	}

	private async runHeartbeat(): Promise<void> {
		if (this.state !== "active" || !this.sessionToken) return;
		let nextDelayMs = this.heartbeatIntervalMs;
		let retryBeforeSessionExpiry = false;
		try {
			const requestStartedAtMs = Date.now();
			const response = await this.network.sendHeartbeat(
				this.sessionToken,
				this.device.getDeviceId(),
			);
			if (!response.ok) {
				if (response.status === 429) {
					const requestedDelayMs = this.retryAfterMs(response);
					nextDelayMs = this.clampRetryBeforeSessionExpiry(requestedDelayMs);
					const expiryProtectionUsed = nextDelayMs < requestedDelayMs;
					this.throttleRetries++;
					if (
						this.throttleRetries > this.maxRetries ||
						(expiryProtectionUsed && this.expiryProtectedThrottleRetryUsed)
					) {
						const message =
							"Heartbeat remained rate limited beyond the current session lifetime";
						this.eventBroker.emit("network:offline", message);
						this.handleFatalError(message);
						return;
					}
					this.expiryProtectedThrottleRetryUsed ||= expiryProtectionUsed;
					this.eventBroker.emit("heartbeat:throttled", nextDelayMs);
					this.log("warn", `Heartbeat throttled; retrying in ${nextDelayMs}ms`);
					return;
				}

				const rejection = await this.readError(response);
				if (response.status >= 400 && response.status < 500) {
					this.emitLicenseRejection(rejection);
					this.handleFatalError(rejection.message);
					return;
				}
				this.recordHeartbeatFailure(rejection.message);
				retryBeforeSessionExpiry = true;
				return;
			}

			const payload = await this.readSessionResponse(response, "heartbeat");
			this.sessionToken = payload.sessionToken;
			this.sessionExpiresAtMs =
				requestStartedAtMs + payload.sessionTtlSeconds * 1_000;
			this.activationResult = this.toActivationResult(payload);
			this.heartbeatIntervalMs = this.clampHeartbeatInterval(
				payload.sessionTtlSeconds,
			);
			nextDelayMs = this.heartbeatIntervalMs;
			this.failureStrikes = 0;
			this.throttleRetries = 0;
			this.expiryProtectedThrottleRetryUsed = false;
			if (this.state === "active") {
				this.eventBroker.emit("heartbeat:success", this.activationResult);
				this.log("debug", "Heartbeat succeeded");
			}
		} catch (error) {
			retryBeforeSessionExpiry = true;
			this.recordHeartbeatFailure(
				error instanceof Error ? error.message : "Network error",
			);
		} finally {
			if (!this.fatalCleanupScheduled) {
				this.scheduleHeartbeat(
					retryBeforeSessionExpiry
						? this.clampRetryBeforeSessionExpiry(nextDelayMs)
						: nextDelayMs,
				);
			}
		}
	}

	private async readSessionResponse(
		response: Response,
		requestName: "activation" | "heartbeat",
	): Promise<ActivateResponse> {
		const payload = await this.readJson(response);
		if (
			!isRecord(payload) ||
			payload.success !== true ||
			!this.isLicenseType(payload.licenseType) ||
			!isRecord(payload.metadata) ||
			typeof payload.sessionToken !== "string" ||
			payload.sessionToken.length < 32 ||
			payload.sessionToken.length > MAX_SESSION_TOKEN_LENGTH ||
			!Number.isSafeInteger(payload.sessionTtlSeconds) ||
			(payload.sessionTtlSeconds as number) < 1 ||
			(payload.sessionTtlSeconds as number) > MAX_SESSION_TTL_SECONDS
		) {
			throw new Error(
				`License server returned an invalid ${requestName} response`,
			);
		}

		return {
			success: true,
			licenseType: payload.licenseType,
			metadata: payload.metadata as JsonObject,
			sessionToken: payload.sessionToken,
			sessionTtlSeconds: payload.sessionTtlSeconds as number,
		};
	}

	private async readUsageResponse(response: Response): Promise<UsageResponse> {
		const payload = await this.readJson(response);
		if (
			!isRecord(payload) ||
			payload.success !== true ||
			typeof payload.meter !== "string" ||
			payload.meter.length < 1 ||
			payload.meter.length > MAX_METER_NAME_LENGTH ||
			!Number.isSafeInteger(payload.units) ||
			(payload.units as number) < 1 ||
			(payload.units as number) > MAX_LICENSE_LIMIT ||
			typeof payload.eventId !== "string" ||
			payload.eventId.length < 1 ||
			payload.eventId.length > MAX_EVENT_ID_LENGTH ||
			!Number.isSafeInteger(payload.remaining) ||
			(payload.remaining as number) < 0 ||
			(payload.remaining as number) > MAX_LICENSE_LIMIT
		) {
			throw new Error("License server returned an invalid usage response");
		}

		return {
			success: true,
			meter: payload.meter,
			units: payload.units as number,
			eventId: payload.eventId,
			remaining: payload.remaining as number,
		};
	}

	private async readDeactivateResponse(
		response: Response,
	): Promise<DeactivateResponse> {
		const payload = await this.readJson(response);
		if (!isRecord(payload) || payload.success !== true) {
			throw new Error(
				"License server returned an invalid deactivation response",
			);
		}
		return { success: true };
	}

	private async readError(response: Response): Promise<ServerRejection> {
		const payload = await this.readJson(response);
		if (
			isRecord(payload) &&
			typeof payload.error === "string" &&
			payload.error.length > 0
		) {
			return {
				message: payload.error,
				...(typeof payload.code === "string" && payload.code.length > 0
					? { code: payload.code }
					: {}),
			};
		}
		return { message: `HTTP ${response.status}` };
	}

	private async readJson(response: Response): Promise<unknown> {
		const declaredLength = response.headers.get("content-length");
		if (
			declaredLength !== null &&
			Number.isFinite(Number(declaredLength)) &&
			Number(declaredLength) > MAX_RESPONSE_BODY_BYTES
		) {
			throw new Error("License server response exceeded the safety limit");
		}

		if (!response.body) return undefined;
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				length += value.byteLength;
				if (length > MAX_RESPONSE_BODY_BYTES) {
					await reader.cancel();
					throw new Error("License server response exceeded the safety limit");
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}

		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}

		try {
			return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
		} catch {
			return undefined;
		}
	}

	private normalizeConsumeInput(input: ConsumeInput): ConsumeInput {
		if (!input || typeof input !== "object" || Array.isArray(input)) {
			throw new Error("consume input must be an object");
		}
		if (typeof input.meter !== "string") {
			throw new Error("meter must be a string");
		}
		const meter = input.meter.trim();
		if (meter.length < 1 || meter.length > MAX_METER_NAME_LENGTH) {
			throw new Error("meter must contain between 1 and 128 characters");
		}
		if (
			!Number.isSafeInteger(input.units) ||
			input.units < 1 ||
			input.units > MAX_LICENSE_LIMIT
		) {
			throw new Error(
				`units must be a positive safe integer no greater than ${MAX_LICENSE_LIMIT}`,
			);
		}
		if (typeof input.eventId !== "string") {
			throw new Error("eventId must be a string");
		}
		const eventId = input.eventId.trim();
		if (eventId.length < 1 || eventId.length > MAX_EVENT_ID_LENGTH) {
			throw new Error("eventId must contain between 1 and 128 characters");
		}
		return { meter, units: input.units, eventId };
	}

	private emitLicenseRejection(rejection: ServerRejection): void {
		if (rejection.code === "LICENSE_EXPIRED") {
			this.eventBroker.emit("license:expired", rejection.message);
			return;
		}
		if (rejection.code === "LICENSE_REVOKED") {
			this.eventBroker.emit("license:revoked", rejection.message);
			return;
		}
		if (rejection.code === "SESSION_INVALID_OR_EXPIRED") {
			this.eventBroker.emit("session:expired", rejection.message);
			return;
		}
		this.eventBroker.emit("license:rejected", rejection.message);
	}

	private toRequestError(
		response: Response,
		rejection: ServerRejection,
	): LicenseRequestError {
		return new LicenseRequestError(
			rejection.message,
			response.status,
			rejection.code as LicenseErrorCode | (string & {}) | undefined,
		);
	}

	private toActivationResult(payload: ActivateResponse): ActivationResult {
		return {
			licenseType: payload.licenseType,
			metadata: payload.metadata,
		};
	}

	private isLicenseType(value: unknown): value is LicenseType {
		return (
			value === "lifetime" ||
			value === "subscription" ||
			value === "metered" ||
			value === "trial"
		);
	}

	private isFatalSessionRejection(code: string | undefined): boolean {
		return (
			code === "LICENSE_INVALID" ||
			code === "LICENSE_REVOKED" ||
			code === "LICENSE_EXPIRED" ||
			code === "IP_NOT_ALLOWED" ||
			code === "DEVICE_NOT_ALLOWED" ||
			code === "SESSION_INVALID_OR_EXPIRED"
		);
	}

	private clampHeartbeatInterval(sessionTtlSeconds: number): number {
		const sessionTtlMs = sessionTtlSeconds * 1_000;
		const twoThirdsMaximumMs = Math.max(1, Math.floor((sessionTtlMs * 2) / 3));
		const renewalSafetyMs = Math.min(
			1_000,
			Math.max(1, Math.floor(sessionTtlMs / 10)),
		);
		const fullRetryBudgetMs = this.requestTimeoutMs * 2 + renewalSafetyMs;
		const retryAwareMaximumMs = Math.max(
			1,
			Math.floor(
				sessionTtlMs > fullRetryBudgetMs
					? sessionTtlMs - fullRetryBudgetMs
					: sessionTtlMs / 3,
			),
		);
		return Math.min(
			this.requestedHeartbeatIntervalMs,
			twoThirdsMaximumMs,
			retryAwareMaximumMs,
		);
	}

	private retryAfterMs(response: Response): number {
		const value = response.headers.get("retry-after")?.trim();
		if (!value) {
			return Math.max(MIN_THROTTLED_RETRY_MS, this.heartbeatIntervalMs);
		}
		if (/^\d+$/.test(value)) {
			const seconds = Number(value);
			if (Number.isSafeInteger(seconds)) {
				return Math.min(
					MAX_TIMER_MS,
					Math.max(MIN_THROTTLED_RETRY_MS, seconds * 1_000),
				);
			}
		}
		const date = Date.parse(value);
		if (Number.isFinite(date)) {
			return Math.min(
				MAX_TIMER_MS,
				Math.max(MIN_THROTTLED_RETRY_MS, date - Date.now()),
			);
		}
		return Math.max(MIN_THROTTLED_RETRY_MS, this.heartbeatIntervalMs);
	}

	private clampRetryBeforeSessionExpiry(desiredDelayMs: number): number {
		if (this.sessionExpiresAtMs === undefined) return desiredDelayMs;
		const remainingMs = this.sessionExpiresAtMs - Date.now();
		const requestSafetyMs = Math.min(
			Math.max(0, remainingMs - 1),
			this.requestTimeoutMs + 1_000,
		);
		const latestSafeDelayMs = Math.max(
			1,
			Math.floor(remainingMs - requestSafetyMs),
		);
		return Math.min(desiredDelayMs, latestSafeDelayMs);
	}

	private recordHeartbeatFailure(message: string): void {
		if (this.state !== "active") return;
		this.failureStrikes++;
		this.eventBroker.emit("heartbeat:failed", message, this.failureStrikes);
		this.log("warn", `Heartbeat failed: ${message}`);
		if (this.failureStrikes >= this.maxRetries) {
			this.eventBroker.emit("network:offline", message);
			this.handleFatalError(message);
		}
	}

	private handleFatalError(reason: string): void {
		if (this.fatalCleanupScheduled) return;
		this.fatalCleanupScheduled = true;
		this.log("error", `FATAL ERROR: ${reason}`);
		queueMicrotask(() => {
			void this.deactivate().catch(() => {
				this.log("warn", "Could not release the license session");
			});
		});
	}

	private clearHeartbeatTimer(): void {
		if (!this.heartbeatTimer) return;
		clearTimeout(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
	}

	private assertConfig(config: LicenseClientConfig): void {
		const allowedFields = new Set([
			"licenseKey",
			"serverUrl",
			"deviceId",
			"heartbeatIntervalMs",
			"maxRetries",
			"requestTimeoutMs",
			"logLevel",
		]);
		if (
			config &&
			Object.keys(config).some((field) => !allowedFields.has(field))
		) {
			throw new Error("LicenseClient configuration contains unknown fields");
		}
		if (
			!config ||
			typeof config.licenseKey !== "string" ||
			config.licenseKey.trim().length < 1 ||
			config.licenseKey.trim().length > MAX_LICENSE_KEY_LENGTH
		) {
			throw new Error("licenseKey must contain between 1 and 128 characters");
		}
		if (typeof config.serverUrl !== "string") {
			throw new Error("serverUrl must be a string");
		}
		if (
			config.deviceId !== undefined &&
			(typeof config.deviceId !== "string" ||
				config.deviceId.trim().length < 1 ||
				config.deviceId.trim().length > 1_024)
		) {
			throw new Error(
				"deviceId must contain between 1 and 1024 trimmed characters",
			);
		}
		for (const [name, value] of [
			["heartbeatIntervalMs", config.heartbeatIntervalMs],
			["maxRetries", config.maxRetries],
			["requestTimeoutMs", config.requestTimeoutMs],
		] as const) {
			if (
				value !== undefined &&
				(!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_MS)
			) {
				throw new Error(
					`${name} must be a positive safe integer no greater than ${MAX_TIMER_MS}`,
				);
			}
		}
		if (
			config.logLevel !== undefined &&
			(typeof config.logLevel !== "string" || !(config.logLevel in LOG_LEVELS))
		) {
			throw new Error("logLevel must be none, error, warn, info, or debug");
		}
	}

	private log(level: Exclude<LogLevel, "none">, message: string): void {
		if (LOG_LEVELS[this.logLevel] < LOG_LEVELS[level]) return;
		const output = `[LicenseClient] ${message}`;
		if (level === "error") console.error(output);
		else if (level === "warn") console.warn(output);
		else console.info(output);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
