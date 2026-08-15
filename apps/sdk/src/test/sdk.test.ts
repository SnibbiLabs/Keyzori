import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { EventBroker } from "../core/EventBroker";
import { NetworkClient } from "../core/NetworkClient";
import * as publicApi from "../index";
import { LicenseClient, LicenseRequestError } from "../index";
import type {
	ActivationResult,
	JsonObject,
	JsonValue,
	LicenseType,
	UsageResult,
} from "../index";

const SESSION_TOKEN = "11111111-1111-4111-8111-111111111111";
const ROTATED_SESSION_TOKEN = "22222222-2222-4222-8222-222222222222";

function activationResponse(
	overrides: Partial<{
		licenseType: LicenseType;
		metadata: JsonObject;
		sessionToken: string;
		sessionTtlSeconds: number;
	}> = {},
): Response {
	return Response.json({
		success: true,
		licenseType: "lifetime",
		metadata: {},
		sessionToken: SESSION_TOKEN,
		sessionTtlSeconds: 45,
		...overrides,
	});
}

describe("Keyzori SDK", () => {
	let originalFetch: typeof global.fetch;
	let originalConsoleError: typeof console.error;
	let originalConsoleWarn: typeof console.warn;
	let clients: LicenseClient[];

	beforeEach(() => {
		originalFetch = global.fetch;
		originalConsoleError = console.error;
		originalConsoleWarn = console.warn;
		console.error = mock(() => {}) as unknown as typeof console.error;
		console.warn = mock(() => {}) as unknown as typeof console.warn;
		clients = [];
	});

	afterEach(async () => {
		await Promise.allSettled(clients.map((client) => client.deactivate()));
		global.fetch = originalFetch;
		console.error = originalConsoleError;
		console.warn = originalConsoleWarn;
	});

	function createClient(
		overrides: Partial<ConstructorParameters<typeof LicenseClient>[0]> = {},
	): LicenseClient {
		const client = new LicenseClient({
			licenseKey: "lic_test",
			serverUrl: "https://licenses.example.com",
			...overrides,
		});
		clients.push(client);
		return client;
	}

	it("exports only the two public runtime classes", () => {
		expect(Object.keys(publicApi).sort()).toEqual([
			"LicenseClient",
			"LicenseRequestError",
		]);
	});

	it("exports canonical license, result, and recursive JSON types", () => {
		const licenseTypes: LicenseType[] = [
			"lifetime",
			"subscription",
			"metered",
			"trial",
		];
		const nested: JsonValue = ["export", true, 3, null, { region: "au" }];
		const activation: ActivationResult = {
			licenseType: licenseTypes[0] as LicenseType,
			metadata: { features: nested },
		};
		const usage: UsageResult = {
			meter: "exports",
			units: 2,
			eventId: "evt_1",
			remaining: 8,
		};
		expect({ activation, usage }).toEqual({
			activation: {
				licenseType: "lifetime",
				metadata: {
					features: ["export", true, 3, null, { region: "au" }],
				},
			},
			usage,
		});
	});

	it("activates once, hashes deviceId, and never sends the key again", async () => {
		const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
		global.fetch = mock(async (input, init) => {
			const path = new URL(input.toString()).pathname;
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			requests.push({ path, body });
			if (path === "/v1/activate") {
				return activationResponse({
					licenseType: "subscription",
					metadata: { tier: "premium" },
				});
			}
			return Response.json({ success: true });
		}) as unknown as typeof fetch;

		const client = createClient({
			licenseKey: " lic_secret ",
			deviceId: " application-device-id ",
		});
		let ready: ActivationResult | undefined;
		client.events.on("ready", (result) => {
			ready = result;
		});

		const first = await client.activate();
		const second = await client.activate();
		expect(first).toEqual({
			licenseType: "subscription",
			metadata: { tier: "premium" },
		});
		expect(second).toEqual(first);
		expect(ready).toEqual(first);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toEqual({
			path: "/v1/activate",
			body: {
				licenseKey: "lic_secret",
				deviceId: createHash("sha256")
					.update("application-device-id")
					.digest("hex"),
			},
		});

		await client.deactivate();
		expect(requests[1]?.path).toBe("/v1/deactivate");
		expect(requests[1]?.body).toEqual({
			sessionToken: SESSION_TOKEN,
			deviceId: requests[0]?.body.deviceId,
		});
		expect(requests[1]?.body).not.toHaveProperty("licenseKey");
	});

	it("heartbeats with the session token and applies refreshed license data", async () => {
		const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
		global.fetch = mock(async (input, init) => {
			const path = new URL(input.toString()).pathname;
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			requests.push({ path, body });
			if (path === "/v1/activate") return activationResponse();
			if (path === "/v1/heartbeat") {
				return activationResponse({
					licenseType: "trial",
					metadata: { feature: "updated" },
					sessionToken: ROTATED_SESSION_TOKEN,
				});
			}
			return Response.json({ success: true });
		}) as unknown as typeof fetch;
		const client = createClient({
			deviceId: "device",
			heartbeatIntervalMs: 1,
		});
		const heartbeat = new Promise<ActivationResult>((resolve) => {
			client.events.once("heartbeat:success", resolve);
		});
		await client.activate();
		const refreshed = await Promise.race([
			heartbeat,
			Bun.sleep(500).then(() => {
				throw new Error("Heartbeat did not run");
			}),
		]);
		expect(refreshed).toEqual({
			licenseType: "trial",
			metadata: { feature: "updated" },
		});
		const heartbeatRequest = requests.find(
			(request) => request.path === "/v1/heartbeat",
		);
		expect(heartbeatRequest?.body).toEqual({
			sessionToken: SESSION_TOKEN,
			deviceId: expect.any(String),
		});
		expect(heartbeatRequest?.body).not.toHaveProperty("licenseKey");

		await client.deactivate();
		const deactivation = requests.find(
			(request) => request.path === "/v1/deactivate",
		);
		expect(deactivation?.body.sessionToken).toBe(ROTATED_SESSION_TOKEN);
	});

	it("consumes named-meter units with an idempotency event", async () => {
		const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
		global.fetch = mock(async (input, init) => {
			const path = new URL(input.toString()).pathname;
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			requests.push({ path, body });
			if (path === "/v1/activate") {
				return activationResponse({ licenseType: "metered" });
			}
			if (path === "/v1/usage") {
				return Response.json({ success: true, ...body, remaining: 7 });
			}
			return Response.json({ success: true });
		}) as unknown as typeof fetch;
		const client = createClient({ deviceId: "device" });
		await client.activate();

		await expect(
			client.consume({ meter: " exports ", units: 3, eventId: " evt_1 " }),
		).resolves.toEqual({
			meter: "exports",
			units: 3,
			eventId: "evt_1",
			remaining: 7,
		});
		const usage = requests.find((request) => request.path === "/v1/usage");
		expect(usage?.body).toEqual({
			sessionToken: SESSION_TOKEN,
			deviceId: expect.any(String),
			meter: "exports",
			units: 3,
			eventId: "evt_1",
		});
		expect(usage?.body).not.toHaveProperty("licenseKey");
	});

	it("rejects invalid configuration and legacy field names", () => {
		expect(
			() =>
				new LicenseClient({
					apiKey: "old-name",
					serverUrl: "https://licenses.example.com",
				} as never),
		).toThrow("LicenseClient configuration contains unknown fields");
		expect(
			() =>
				new LicenseClient({
					licenseKey: " ",
					serverUrl: "https://licenses.example.com",
				}),
		).toThrow("licenseKey must contain between 1 and 128");
		expect(
			() =>
				new LicenseClient({
					licenseKey: "lic_test",
					serverUrl: "https://licenses.example.com",
					deviceId: " ",
				}),
		).toThrow("deviceId must contain between 1 and 1024");
		expect(
			() =>
				new LicenseClient({
					licenseKey: "lic_test",
					serverUrl: "https://licenses.example.com",
					heartbeatIntervalMs: 0,
				}),
		).toThrow("heartbeatIntervalMs must be a positive safe integer");
		expect(
			() =>
				new LicenseClient({
					licenseKey: "lic_test",
					serverUrl: "https://licenses.example.com",
					logLevel: "verbose",
				} as never),
		).toThrow("logLevel must be none, error, warn, info, or debug");
	});

	it("allows only HTTPS or loopback HTTP server URLs", () => {
		expect(
			() => new NetworkClient("http://licenses.example.com", "lic_test"),
		).toThrow("serverUrl must use HTTPS");
		expect(
			() => new NetworkClient("https://user:pass@example.com", "lic_test"),
		).toThrow("serverUrl must use HTTPS");
		expect(
			() => new NetworkClient("https://example.com?token=secret", "lic_test"),
		).toThrow("serverUrl must use HTTPS");
		expect(
			() => new NetworkClient("https://licenses.example.com", "lic_test"),
		).not.toThrow();
		expect(
			() => new NetworkClient("http://localhost:3000", "lic_test"),
		).not.toThrow();
		expect(
			() => new NetworkClient("http://[::1]:3000", "lic_test"),
		).not.toThrow();
	});

	it("refuses redirects without contacting the target", async () => {
		for (const status of [307, 308]) {
			let targetRequests = 0;
			const target = Bun.serve({
				port: 0,
				fetch() {
					targetRequests++;
					return activationResponse();
				},
			});
			const origin = Bun.serve({
				port: 0,
				fetch() {
					return new Response(null, {
						status,
						headers: { location: new URL("/sink", target.url).toString() },
					});
				},
			});
			try {
				const network = new NetworkClient(origin.url.toString(), "lic_secret");
				await expect(network.sendActivate("device")).rejects.toThrow();
				expect(targetRequests).toBe(0);
			} finally {
				origin.stop(true);
				target.stop(true);
			}
		}
	});

	it("bounds response bodies before parsing success or error payloads", async () => {
		for (const status of [200, 403]) {
			global.fetch = mock(
				async () =>
					new Response(JSON.stringify({ error: "x".repeat(262_144) }), {
						status,
					}),
			) as unknown as typeof fetch;
			const client = createClient();
			await expect(client.activate()).rejects.toThrow(
				"response exceeded the safety limit",
			);
		}
	});

	it("rejects malformed activation responses", async () => {
		for (const payload of [
			{ success: true },
			{
				success: true,
				licenseType: "PERPETUAL",
				metadata: {},
				sessionToken: SESSION_TOKEN,
				sessionTtlSeconds: 45,
			},
			{
				success: true,
				licenseType: "lifetime",
				metadata: [],
				sessionToken: SESSION_TOKEN,
				sessionTtlSeconds: 45,
			},
			{
				success: true,
				licenseType: "lifetime",
				metadata: {},
				sessionToken: "short",
				sessionTtlSeconds: 45,
			},
			{
				success: true,
				licenseType: "lifetime",
				metadata: {},
				sessionToken: SESSION_TOKEN,
				sessionTtlSeconds: 0,
			},
		]) {
			global.fetch = mock(async () =>
				Response.json(payload),
			) as unknown as typeof fetch;
			const client = createClient();
			await expect(client.activate()).rejects.toThrow(
				"invalid activation response",
			);
		}
	});

	it("throws structured request errors and emits precise activation events", async () => {
		for (const scenario of [
			{ code: "LICENSE_EXPIRED", event: "license:expired" as const },
			{ code: "LICENSE_REVOKED", event: "license:revoked" as const },
			{ code: "LICENSE_INVALID", event: "license:rejected" as const },
			{ code: "DEVICE_NOT_ALLOWED", event: "license:rejected" as const },
		]) {
			global.fetch = mock(async () =>
				Response.json(
					{ error: "Blocked", code: scenario.code },
					{ status: 403 },
				),
			) as unknown as typeof fetch;
			const client = createClient();
			let reason: string | undefined;
			client.events.once(scenario.event, (value) => {
				reason = value;
			});
			try {
				await client.activate();
				throw new Error("Expected activation to fail");
			} catch (error) {
				expect(error).toBeInstanceOf(LicenseRequestError);
				expect((error as LicenseRequestError).status).toBe(403);
				expect((error as LicenseRequestError).code).toBe(scenario.code);
			}
			expect(reason).toBe("Blocked");
		}
	});

	it("keeps meter rejections recoverable", async () => {
		let usageCalls = 0;
		global.fetch = mock(async (input, init) => {
			const path = new URL(input.toString()).pathname;
			if (path === "/v1/activate") {
				return activationResponse({ licenseType: "metered" });
			}
			if (path === "/v1/usage") {
				usageCalls++;
				if (usageCalls === 1) {
					return Response.json(
						{ error: "Meter exhausted", code: "METER_EXHAUSTED" },
						{ status: 409 },
					);
				}
				const body = JSON.parse(String(init?.body));
				return Response.json({ success: true, ...body, remaining: 0 });
			}
			return Response.json({ success: true });
		}) as unknown as typeof fetch;
		const client = createClient();
		await client.activate();
		let rejection: string | undefined;
		client.events.once("license:rejected", (reason) => {
			rejection = reason;
		});

		await expect(
			client.consume({ meter: "exports", units: 1, eventId: "evt_1" }),
		).rejects.toMatchObject({
			name: "LicenseRequestError",
			status: 409,
			code: "METER_EXHAUSTED",
		});
		expect(rejection).toBe("Meter exhausted");
		await expect(
			client.consume({ meter: "exports", units: 1, eventId: "evt_2" }),
		).resolves.toMatchObject({ eventId: "evt_2", remaining: 0 });
	});

	it("validates usage inputs locally", async () => {
		global.fetch = mock(async (input) => {
			if (new URL(input.toString()).pathname === "/v1/activate") {
				return activationResponse({ licenseType: "metered" });
			}
			return Response.json({ success: true });
		}) as unknown as typeof fetch;
		const client = createClient();
		await expect(
			client.consume({ meter: "exports", units: 1, eventId: "evt" }),
		).rejects.toThrow("call activate() first");
		await client.activate();
		await expect(
			client.consume({ meter: " ", units: 1, eventId: "evt" }),
		).rejects.toThrow("meter must contain between 1 and 128");
		await expect(
			client.consume({ meter: "exports", units: 0, eventId: "evt" }),
		).rejects.toThrow("units must be a positive safe integer");
		await expect(
			client.consume({
				meter: "credits",
				units: 2_147_483_648,
				eventId: "evt-too-large",
			}),
		).rejects.toThrow("no greater than 2147483647");
		await expect(
			client.consume({ meter: "exports", units: 1, eventId: " " }),
		).rejects.toThrow("eventId must contain between 1 and 128");
	});

	it("rejects mismatched or malformed usage responses", async () => {
		let usageResponse: Record<string, unknown> = {
			success: true,
			meter: "other",
			units: 1,
			eventId: "evt",
			remaining: 9,
		};
		global.fetch = mock(async (input) => {
			const path = new URL(input.toString()).pathname;
			if (path === "/v1/activate") return activationResponse();
			if (path === "/v1/usage") return Response.json(usageResponse);
			return Response.json({ success: true });
		}) as unknown as typeof fetch;
		const client = createClient();
		await client.activate();
		await expect(
			client.consume({ meter: "exports", units: 1, eventId: "evt" }),
		).rejects.toThrow("mismatched usage response");

		usageResponse = {
			success: true,
			meter: "exports",
			units: 1,
			eventId: "evt",
			remaining: -1,
		};
		await expect(
			client.consume({ meter: "exports", units: 1, eventId: "evt" }),
		).rejects.toThrow("invalid usage response");
	});

	it("contains listener failures while enforcing heartbeat failure limits", async () => {
		let heartbeatCalls = 0;
		let deactivationCalls = 0;
		global.fetch = mock(async (input) => {
			const path = new URL(input.toString()).pathname;
			if (path === "/v1/activate") return activationResponse();
			if (path === "/v1/heartbeat") {
				heartbeatCalls++;
				return Response.json(
					{ error: "Temporary failure", code: "INTERNAL_ERROR" },
					{ status: 503 },
				);
			}
			deactivationCalls++;
			return Response.json({ success: true });
		}) as unknown as typeof fetch;
		const client = createClient({ heartbeatIntervalMs: 1, maxRetries: 1 });
		client.events.on("heartbeat:failed", () => {
			throw new Error("consumer failure");
		});
		const offline = new Promise<void>((resolve) => {
			client.events.once("network:offline", () => {
				resolve();
				throw new Error("consumer failure");
			});
		});
		await client.activate();
		await Promise.race([
			offline,
			Bun.sleep(500).then(() => {
				throw new Error("Offline event did not run");
			}),
		]);
		await Bun.sleep(10);
		expect(heartbeatCalls).toBe(1);
		expect(deactivationCalls).toBe(1);
	});

	it("retries network and 5xx heartbeat failures before the session TTL", async () => {
		for (const failureMode of ["network", "5xx"] as const) {
			let heartbeatCalls = 0;
			let sessionExpiresAtMs = 0;
			global.fetch = mock(async (input) => {
				const path = new URL(input.toString()).pathname;
				if (path === "/v1/activate") {
					sessionExpiresAtMs = Date.now() + 1_000;
					return activationResponse({ sessionTtlSeconds: 1 });
				}
				if (path === "/v1/heartbeat") {
					heartbeatCalls++;
					if (heartbeatCalls === 1) {
						if (failureMode === "network") throw new TypeError("offline");
						return Response.json(
							{ error: "Temporary failure", code: "INTERNAL_ERROR" },
							{ status: 503 },
						);
					}
					if (Date.now() >= sessionExpiresAtMs) {
						return Response.json(
							{
								error: "Session expired",
								code: "SESSION_INVALID_OR_EXPIRED",
							},
							{ status: 403 },
						);
					}
					return activationResponse({ sessionTtlSeconds: 1 });
				}
				return Response.json({ success: true });
			}) as unknown as typeof fetch;
			const client = createClient({
				heartbeatIntervalMs: 1_000,
				maxRetries: 2,
				requestTimeoutMs: 1,
			});
			const recovered = new Promise<ActivationResult>((resolve) => {
				client.events.once("heartbeat:success", resolve);
			});

			await client.activate();
			await Promise.race([
				recovered,
				Bun.sleep(1_500).then(() => {
					throw new Error(
						`${failureMode} heartbeat did not recover before TTL`,
					);
				}),
			]);
			expect(heartbeatCalls).toBe(2);
			expect(Date.now()).toBeLessThan(sessionExpiresAtMs);
			await client.deactivate();
		}
	});

	it("preserves once semantics while containing listener exceptions", () => {
		const listenerErrors: unknown[] = [];
		const broker = new EventBroker((error) => listenerErrors.push(error));
		let calls = 0;
		broker.once("heartbeat:success", () => {
			calls++;
			throw new Error("listener failed");
		});
		const result: ActivationResult = { licenseType: "lifetime", metadata: {} };
		broker.emit("heartbeat:success", result);
		broker.emit("heartbeat:success", result);
		expect(calls).toBe(1);
		expect(listenerErrors).toHaveLength(1);
	});

	it("bounds Retry-After by the current session TTL", async () => {
		let heartbeatCalls = 0;
		let sessionExpiresAtMs = 0;
		global.fetch = mock(async (input) => {
			const path = new URL(input.toString()).pathname;
			if (path === "/v1/activate") {
				sessionExpiresAtMs = Date.now() + 1_000;
				return activationResponse({ sessionTtlSeconds: 1 });
			}
			if (path === "/v1/heartbeat") {
				heartbeatCalls++;
				if (heartbeatCalls === 1) {
					return Response.json(
						{ error: "Too many requests", code: "RATE_LIMITED" },
						{ status: 429, headers: { "retry-after": "60" } },
					);
				}
				if (Date.now() >= sessionExpiresAtMs) {
					return Response.json(
						{
							error: "Session expired",
							code: "SESSION_INVALID_OR_EXPIRED",
						},
						{ status: 403 },
					);
				}
				return activationResponse({ sessionTtlSeconds: 1 });
			}
			return Response.json({ success: true });
		}) as unknown as typeof fetch;
		const client = createClient({
			heartbeatIntervalMs: 1_000,
			maxRetries: 1,
			requestTimeoutMs: 1,
		});
		let failures = 0;
		client.events.on("heartbeat:failed", () => failures++);
		const throttled = new Promise<number>((resolve) => {
			client.events.once("heartbeat:throttled", resolve);
		});
		const recovered = new Promise<ActivationResult>((resolve) => {
			client.events.once("heartbeat:success", resolve);
		});
		await client.activate();
		const [delay] = await Promise.race([
			Promise.all([throttled, recovered]),
			Bun.sleep(1_500).then(() => {
				throw new Error("Throttled heartbeat did not recover");
			}),
		]);
		expect(delay).toBeLessThan(334);
		expect(heartbeatCalls).toBe(2);
		expect(Date.now()).toBeLessThan(sessionExpiresAtMs);
		expect(failures).toBe(0);
	});

	it("terminates repeated expiry-clamped throttles without a retry storm", async () => {
		let heartbeatCalls = 0;
		global.fetch = mock(async (input) => {
			const path = new URL(input.toString()).pathname;
			if (path === "/v1/activate") {
				return activationResponse({ sessionTtlSeconds: 1 });
			}
			if (path === "/v1/heartbeat") {
				heartbeatCalls++;
				return Response.json(
					{ error: "Too many requests", code: "RATE_LIMITED" },
					{ status: 429, headers: { "retry-after": "60" } },
				);
			}
			return Response.json({ success: true });
		}) as unknown as typeof fetch;
		const client = createClient({
			heartbeatIntervalMs: 1_000,
			maxRetries: 5,
			requestTimeoutMs: 1,
		});
		const offline = new Promise<string>((resolve) => {
			client.events.once("network:offline", resolve);
		});

		await client.activate();
		await Promise.race([
			offline,
			Bun.sleep(1_500).then(() => {
				throw new Error("Repeated throttle did not terminate");
			}),
		]);
		await Bun.sleep(20);
		expect(heartbeatCalls).toBe(2);
	});

	it("maps an invalid heartbeat session to a fatal session event", async () => {
		global.fetch = mock(async (input) => {
			const path = new URL(input.toString()).pathname;
			if (path === "/v1/activate") return activationResponse();
			if (path === "/v1/heartbeat") {
				return Response.json(
					{
						error: "Session expired",
						code: "SESSION_INVALID_OR_EXPIRED",
					},
					{ status: 403 },
				);
			}
			return Response.json({ success: true });
		}) as unknown as typeof fetch;
		const client = createClient({ heartbeatIntervalMs: 1 });
		const expired = new Promise<string>((resolve) => {
			client.events.once("session:expired", resolve);
		});
		await client.activate();
		await expect(expired).resolves.toBe("Session expired");
		await Bun.sleep(10);
		await expect(
			client.consume({ meter: "usage", units: 1, eventId: "evt" }),
		).rejects.toThrow("not active");
	});

	it("makes explicit deactivation idempotent and surfaces server errors", async () => {
		let deactivationCalls = 0;
		global.fetch = mock(async (input) => {
			const path = new URL(input.toString()).pathname;
			if (path === "/v1/activate") return activationResponse();
			deactivationCalls++;
			return Response.json(
				{ error: "Unavailable", code: "INTERNAL_ERROR" },
				{ status: 503 },
			);
		}) as unknown as typeof fetch;
		const client = createClient({ logLevel: "warn" });
		await client.activate();
		const first = client.deactivate();
		const second = client.deactivate();
		expect(first).toBe(second);
		await expect(first).rejects.toMatchObject({
			name: "LicenseRequestError",
			status: 503,
			code: "INTERNAL_ERROR",
		});
		expect(deactivationCalls).toBe(1);
		expect(console.warn).toHaveBeenCalled();
	});

	it("deactivates a session created while activation is still in flight", async () => {
		let resolveActivation: ((response: Response) => void) | undefined;
		const requests: string[] = [];
		global.fetch = mock(async (input) => {
			const path = new URL(input.toString()).pathname;
			requests.push(path);
			if (path === "/v1/activate") {
				return await new Promise<Response>((resolve) => {
					resolveActivation = resolve;
				});
			}
			return Response.json({ success: true });
		}) as unknown as typeof fetch;
		const client = createClient();
		const activation = client.activate();
		const deactivation = client.deactivate();
		if (!resolveActivation) throw new Error("Activation did not start");
		resolveActivation(activationResponse());
		await expect(activation).rejects.toThrow("deactivated during activation");
		await expect(deactivation).resolves.toBeUndefined();
		expect(requests).toEqual(["/v1/activate", "/v1/deactivate"]);
		await expect(client.activate()).rejects.toThrow("has been deactivated");
	});
});
