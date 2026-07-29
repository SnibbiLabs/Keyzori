/**
 * Low-level class responsible for raw HTTP communication between an
 * application and the Keyzori Licensing Server. Most users should prefer
 * LicenseClient, which adds validation, events, retries, and heartbeats.
 */
export class NetworkClient {
	private readonly serverUrl: string;
	private readonly apiKey: string;
	private sessionToken?: string;
	private readonly requestTimeoutMs: number;

	/**
	 * Constructs a new NetworkClient.
	 * @param serverUrl - The base URL of the licensing server.
	 * @param apiKey - The user's API key.
	 */
	constructor(serverUrl: string, apiKey: string, requestTimeoutMs = 10_000) {
		this.serverUrl = normalizeSecureServerUrl(serverUrl);
		this.apiKey = apiKey;
		this.requestTimeoutMs = requestTimeoutMs;
	}

	public setSessionToken(sessionToken: string): void {
		this.sessionToken = sessionToken;
	}

	/**
	 * Sends a POST request to the `/v1/handshake` endpoint.
	 * Used for initial initialization and periodic heartbeats.
	 *
	 * @param hwid - The unique hardware identifier of the current machine.
	 * @returns {Promise<Response>} The raw HTTP Fetch response.
	 */
	public async sendHandshake(hwid: string): Promise<Response> {
		return fetch(`${this.serverUrl}/v1/handshake`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				apiKey: this.apiKey,
				hwid,
				...(this.sessionToken ? { sessionToken: this.sessionToken } : {}),
			}),
			redirect: "error",
			signal: AbortSignal.timeout(this.requestTimeoutMs),
		});
	}

	/**
	 * Sends a POST request to the `/v1/logout` endpoint.
	 * Instructs the server to release the current server-issued session token.
	 *
	 * @returns {Promise<Response>} The raw HTTP Fetch response.
	 */
	public async sendLogout(hwid: string): Promise<Response> {
		if (!this.sessionToken) return new Response(null, { status: 204 });
		return fetch(`${this.serverUrl}/v1/logout`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				apiKey: this.apiKey,
				hwid,
				sessionToken: this.sessionToken,
			}),
			redirect: "error",
			signal: AbortSignal.timeout(this.requestTimeoutMs),
		});
	}
}

function normalizeSecureServerUrl(serverUrl: string): string {
	try {
		const url = new URL(serverUrl);
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
		return serverUrl.replace(/\/$/, "");
	} catch {
		throw new Error(
			"serverUrl must use HTTPS (HTTP is allowed only for loopback development)",
		);
	}
}
