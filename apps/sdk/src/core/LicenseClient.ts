import { EventBroker } from "./EventBroker";
import { HardwareManager } from "./HardwareManager";
import { NetworkClient } from "./NetworkClient";
import type {
	KeyType,
	LicenseClientConfig,
	LicenseEvents,
	JsonObject,
	LicenseErrorCode,
	LogLevel,
} from "./types";

interface HandshakePayload {
	success: true;
	type: KeyType;
	customFields: JsonObject;
	sessionToken: string;
	sessionTtlSeconds: number;
}

const DEFAULT_MAX_RESPONSE_BODY_BYTES = 262_144;
const DEFAULT_SESSION_TTL_SECONDS = 45;
const MAX_SESSION_TTL_SECONDS = 86_400;

type ClientState = "idle" | "initializing" | "active" | "destroyed";

const LOG_LEVELS: Record<LogLevel, number> = {
	none: 0,
	error: 1,
	warn: 2,
	info: 3,
	debug: 4,
};

/** Manages license verification, session tracking, and recurring heartbeats. */
export class LicenseClient {
	public readonly events: LicenseEvents;

	private readonly hardware: HardwareManager;
	private readonly network: NetworkClient;
	private readonly eventBroker: EventBroker;
	private readonly requestedHeartbeatIntervalMs: number;
	private readonly maxRetries: number;
	private readonly logLevel: LogLevel;
	private heartbeatIntervalMs: number;
	private heartbeatTimer?: ReturnType<typeof setTimeout>;
	private initialization?: Promise<JsonObject>;
	private destruction?: Promise<void>;
	private customFields?: JsonObject;
	private state: ClientState = "idle";
	private failureStrikes = 0;

	constructor(config: LicenseClientConfig) {
		this.assertConfig(config);
		this.logLevel = config.logLevel ?? "none";
		this.eventBroker = new EventBroker(() => {
			this.log("warn", "A license event listener threw an error");
		});
		this.events = this.eventBroker;
		this.hardware = new HardwareManager(config.hardwareId);
		this.network = new NetworkClient(
			config.serverUrl,
			config.apiKey,
			config.requestTimeoutMs ?? 10_000,
		);
		this.requestedHeartbeatIntervalMs = config.heartbeatIntervalMs ?? 30_000;
		this.heartbeatIntervalMs = this.requestedHeartbeatIntervalMs;
		this.maxRetries = config.maxRetries ?? 2;
	}

	/** Validates the license once and starts heartbeats after success. */
	public initialize(): Promise<JsonObject> {
		if (this.state === "destroyed") {
			return Promise.reject(new Error("LicenseClient has been destroyed"));
		}
		if (this.state === "active" && this.customFields) {
			return Promise.resolve(this.customFields);
		}
		if (this.initialization) return this.initialization;

		this.state = "initializing";
		this.initialization = this.initializeOnce();
		return this.initialization;
	}

	private async initializeOnce(): Promise<JsonObject> {
		try {
			const response = await this.network.sendHandshake(
				this.hardware.getHwid(),
			);
			if (!response.ok) {
				const rejection = await this.readError(response);
				if (response.status === 403) {
					this.emitLicenseRejection(rejection);
				}
				throw new Error(`License Block: ${rejection.message}`);
			}

			const payload = await this.readHandshake(response);
			if (this.state === "destroyed") {
				throw new Error("LicenseClient was destroyed during initialization");
			}
			this.customFields = payload.customFields;
			this.network.setSessionToken(payload.sessionToken);
			this.heartbeatIntervalMs = this.clampHeartbeatInterval(
				payload.sessionTtlSeconds,
			);
			this.state = "active";
			this.eventBroker.emit("ready", payload.customFields);
			this.log("info", `License initialized as ${payload.type}`);
			this.scheduleHeartbeat();
			return payload.customFields;
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Initialization failed";
			if (this.state !== "destroyed") this.handleFatalError(message);
			throw error;
		}
	}

	private async readHandshake(response: Response): Promise<HandshakePayload> {
		const payload = await this.readJson(response);
		if (
			!payload ||
			typeof payload !== "object" ||
			!("success" in payload) ||
			payload.success !== true ||
			!("type" in payload) ||
			!this.isKeyType(payload.type) ||
			!("customFields" in payload) ||
			!payload.customFields ||
			typeof payload.customFields !== "object" ||
			Array.isArray(payload.customFields) ||
			!("sessionToken" in payload) ||
			typeof payload.sessionToken !== "string" ||
			payload.sessionToken.length < 32
		) {
			throw new Error("License server returned an invalid handshake response");
		}
		const sessionTtlSeconds =
			"sessionTtlSeconds" in payload
				? payload.sessionTtlSeconds
				: DEFAULT_SESSION_TTL_SECONDS;
		if (
			!Number.isInteger(sessionTtlSeconds) ||
			(sessionTtlSeconds as number) < 1 ||
			(sessionTtlSeconds as number) > MAX_SESSION_TTL_SECONDS
		) {
			throw new Error("License server returned an invalid session TTL");
		}
		return {
			success: true,
			type: payload.type,
			customFields: payload.customFields as JsonObject,
			sessionToken: payload.sessionToken,
			sessionTtlSeconds: sessionTtlSeconds as number,
		};
	}

	private isKeyType(value: unknown): value is KeyType {
		return (
			value === "PERPETUAL" || value === "SUBSCRIPTION" || value === "USAGE"
		);
	}

	private async readError(
		response: Response,
	): Promise<{ message: string; code?: string }> {
		const payload = await this.readJson(response);
		if (
			payload !== null &&
			typeof payload === "object" &&
			"error" in payload &&
			typeof payload.error === "string"
		) {
			return {
				message: payload.error,
				...("code" in payload && typeof payload.code === "string"
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
			Number(declaredLength) > DEFAULT_MAX_RESPONSE_BODY_BYTES
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
				if (length > DEFAULT_MAX_RESPONSE_BODY_BYTES) {
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

	private scheduleHeartbeat(delayMs = this.heartbeatIntervalMs): void {
		if (this.state !== "active") return;
		this.heartbeatTimer = setTimeout(() => void this.runHeartbeat(), delayMs);
		this.heartbeatTimer.unref();
	}

	private async runHeartbeat(): Promise<void> {
		if (this.state !== "active") return;
		let nextDelayMs = this.heartbeatIntervalMs;
		try {
			const response = await this.network.sendHandshake(
				this.hardware.getHwid(),
			);
			if (!response.ok) {
				if (response.status === 429) {
					nextDelayMs = this.retryAfterMs(response);
					this.eventBroker.emit("heartbeat:throttled", nextDelayMs);
					this.log("warn", `Heartbeat throttled; retrying in ${nextDelayMs}ms`);
					return;
				}
				if (response.status === 403) {
					const rejection = await this.readError(response);
					this.emitLicenseRejection(rejection);
					this.handleFatalError(rejection.message);
					return;
				}
				this.recordHeartbeatFailure(`HTTP ${response.status}`);
				return;
			}

			const payload = await this.readHandshake(response);
			this.network.setSessionToken(payload.sessionToken);
			this.heartbeatIntervalMs = this.clampHeartbeatInterval(
				payload.sessionTtlSeconds,
			);
			nextDelayMs = this.heartbeatIntervalMs;
			this.failureStrikes = 0;
			this.eventBroker.emit("heartbeat:success");
			this.log("debug", "Heartbeat succeeded");
		} catch (error) {
			this.recordHeartbeatFailure(
				error instanceof Error ? error.message : "Network error",
			);
		} finally {
			this.scheduleHeartbeat(nextDelayMs);
		}
	}

	private clampHeartbeatInterval(sessionTtlSeconds: number): number {
		const safeMaximumMs = Math.max(
			1,
			Math.floor((sessionTtlSeconds * 1_000 * 2) / 3),
		);
		return Math.min(this.requestedHeartbeatIntervalMs, safeMaximumMs);
	}

	private retryAfterMs(response: Response): number {
		const value = response.headers.get("retry-after")?.trim();
		if (!value) return this.heartbeatIntervalMs;
		if (/^\d+$/.test(value)) {
			const seconds = Number(value);
			if (Number.isSafeInteger(seconds)) return Math.max(1, seconds * 1_000);
		}
		const date = Date.parse(value);
		if (Number.isFinite(date)) return Math.max(1, date - Date.now());
		return this.heartbeatIntervalMs;
	}

	private emitLicenseRejection(rejection: {
		message: string;
		code?: string;
	}): void {
		const { message, code } = rejection;
		if (code === "TRIAL_EXPIRED" || code === "SUBSCRIPTION_EXPIRED") {
			this.eventBroker.emit("license:expired", message);
			return;
		}
		if (code === "LICENSE_INVALID_OR_REVOKED") {
			this.eventBroker.emit("license:revoked", message);
			return;
		}
		if (code === "SESSION_INVALID_OR_EXPIRED") {
			this.eventBroker.emit("session:expired", message);
			return;
		}
		if (this.isLicenseErrorCode(code)) {
			this.eventBroker.emit("license:rejected", message);
			return;
		}

		// Compatibility with servers released before structured error codes.
		if (/trial|subscription/i.test(message) && /expired/i.test(message)) {
			this.eventBroker.emit("license:expired", message);
		} else if (/session/i.test(message) && /expired|invalid/i.test(message)) {
			this.eventBroker.emit("session:expired", message);
		} else {
			this.eventBroker.emit("license:revoked", message);
		}
	}

	private isLicenseErrorCode(
		value: string | undefined,
	): value is LicenseErrorCode {
		return (
			value === "IP_NOT_WHITELISTED" ||
			value === "HWID_NOT_WHITELISTED" ||
			value === "CONCURRENT_SESSION_LIMIT" ||
			value === "USAGE_EXHAUSTED" ||
			value === "IP_REGISTRATION_LIMIT" ||
			value === "HWID_REGISTRATION_LIMIT"
		);
	}

	private recordHeartbeatFailure(message: string): void {
		this.failureStrikes++;
		this.eventBroker.emit("heartbeat:failed", message, this.failureStrikes);
		this.log("warn", `Heartbeat failed: ${message}`);
		if (this.failureStrikes >= this.maxRetries) {
			this.eventBroker.emit("network:offline", message);
			this.handleFatalError(message);
		}
	}

	private handleFatalError(reason: string): void {
		this.log("error", `FATAL ERROR: ${reason}`);
		void this.destroy();
	}

	/** Stops heartbeats and releases the server-side session. Safe to call twice. */
	public destroy(): Promise<void> {
		if (this.destruction) return this.destruction;
		this.state = "destroyed";
		if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
		this.destruction = this.releaseSession();
		return this.destruction;
	}

	private async releaseSession(): Promise<void> {
		try {
			const response = await this.network.sendLogout(this.hardware.getHwid());
			if (!response.ok) {
				this.log(
					"warn",
					`Could not release the license session: HTTP ${response.status}`,
				);
			}
		} catch {
			this.log("warn", "Could not release the license session");
		} finally {
			this.eventBroker.removeAllListeners();
		}
	}

	private assertConfig(config: LicenseClientConfig): void {
		if (!config.apiKey.trim()) throw new Error("apiKey is required");
		if (
			config.hardwareId !== undefined &&
			(typeof config.hardwareId !== "string" ||
				config.hardwareId.trim().length < 1 ||
				config.hardwareId.trim().length > 1_024)
		) {
			throw new Error(
				"hardwareId must contain between 1 and 1024 trimmed characters",
			);
		}
		for (const [name, value] of [
			["heartbeatIntervalMs", config.heartbeatIntervalMs],
			["maxRetries", config.maxRetries],
			["requestTimeoutMs", config.requestTimeoutMs],
		] as const) {
			if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
				throw new Error(`${name} must be a positive integer`);
			}
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
