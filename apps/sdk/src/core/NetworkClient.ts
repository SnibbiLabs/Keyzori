import type { ConsumeInput } from "./types";

/** Raw HTTP transport used by {@link LicenseClient}. */
export class NetworkClient {
	private readonly serverUrl: string;

	constructor(
		serverUrl: string,
		private readonly licenseKey: string,
		private readonly requestTimeoutMs = 10_000,
	) {
		this.serverUrl = normalizeSecureServerUrl(serverUrl);
	}

	/** Starts a session. This is the only request that includes the license key. */
	public sendActivate(deviceId: string): Promise<Response> {
		return this.post("/v1/activate", {
			licenseKey: this.licenseKey,
			deviceId,
		});
	}

	/** Refreshes an existing server-issued session. */
	public sendHeartbeat(
		sessionToken: string,
		deviceId: string,
	): Promise<Response> {
		return this.post("/v1/heartbeat", { sessionToken, deviceId });
	}

	/** Atomically records an idempotent named-meter usage event. */
	public sendUsage(
		sessionToken: string,
		deviceId: string,
		input: ConsumeInput,
	): Promise<Response> {
		return this.post("/v1/usage", {
			sessionToken,
			deviceId,
			meter: input.meter,
			units: input.units,
			eventId: input.eventId,
		});
	}

	/** Releases an existing server-issued session. */
	public sendDeactivate(
		sessionToken: string,
		deviceId: string,
	): Promise<Response> {
		return this.post("/v1/deactivate", { sessionToken, deviceId });
	}

	private post(path: string, body: object): Promise<Response> {
		return fetch(`${this.serverUrl}${path}`, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			redirect: "error",
			signal: AbortSignal.timeout(this.requestTimeoutMs),
		});
	}
}

function normalizeSecureServerUrl(serverUrl: string): string {
	try {
		const url = new URL(serverUrl.trim());
		const isLoopback =
			url.hostname === "localhost" ||
			url.hostname === "127.0.0.1" ||
			url.hostname === "[::1]";
		if (
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			(url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback))
		) {
			throw new Error();
		}
		return url.toString().replace(/\/+$/, "");
	} catch {
		throw new Error(
			"serverUrl must use HTTPS (HTTP is allowed only for loopback development)",
		);
	}
}
