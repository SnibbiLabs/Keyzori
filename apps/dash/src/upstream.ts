import type { DashboardConfig } from "./config";

const MAX_UPSTREAM_RESPONSE_BYTES = 2 * 1024 * 1024;

export async function readBoundedResponseText(
	response: Response,
	maximumBytes = MAX_UPSTREAM_RESPONSE_BYTES,
): Promise<string> {
	const declaredLength = response.headers.get("content-length");
	if (
		declaredLength !== null &&
		Number.isFinite(Number(declaredLength)) &&
		Number(declaredLength) > maximumBytes
	) {
		await response.body?.cancel();
		throw new Error("Upstream response exceeded the size limit.");
	}
	if (!response.body) return "";

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > maximumBytes) {
				await reader.cancel();
				throw new Error("Upstream response exceeded the size limit.");
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
	return new TextDecoder().decode(bytes);
}

export class KeyzoriApi {
	constructor(private readonly config: DashboardConfig) {}

	async request(
		path: string,
		method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
		body?: unknown,
	): Promise<Response> {
		const url = new URL(path, this.config.serverUrl);
		try {
			const response = await fetch(url, {
				method,
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					"x-admin-key": this.config.adminKey,
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				redirect: "manual",
				signal: AbortSignal.timeout(this.config.upstreamTimeoutMs),
			});
			if (response.status >= 300 && response.status < 400) {
				throw new Error("Upstream redirects are not allowed.");
			}
			const text = await readBoundedResponseText(response);
			let payload: unknown = null;
			if (text) {
				try {
					payload = JSON.parse(text);
				} catch {
					throw new Error("Upstream returned a non-JSON response.");
				}
			}
			return Response.json(payload, {
				status: response.status,
				headers: { "cache-control": "no-store" },
			});
		} catch (error) {
			console.error(
				JSON.stringify({
					level: "error",
					event: "keyzori_upstream_failed",
					method,
					path,
					message: error instanceof Error ? error.message : "Unknown error",
				}),
			);
			return Response.json(
				{ error: "The Keyzori server is unavailable." },
				{ status: 502 },
			);
		}
	}
}
