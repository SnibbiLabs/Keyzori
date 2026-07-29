import { describe, expect, mock, test } from "bun:test";
import Elysia from "elysia";
import type { HandshakeService } from "../application/services/HandshakeService";
import { ClientIpResolver } from "../controllers/clientIp";
import { handshakePlugin } from "../controllers/handshake";
import {
	rateLimiter,
	RedisSlidingWindowRateLimiter,
} from "../plugins/ratelimit";

describe("rate limiting", () => {
	test("isolates license principals sharing one source address", async () => {
		const consumedKeys: string[] = [];
		const limiter = {
			consume: mock(async (key: string) => {
				consumedKeys.push(key);
				return { allowed: true, retryAfterSeconds: 0 };
			}),
		} as unknown as RedisSlidingWindowRateLimiter;
		const service = {
			processHandshake: mock(
				async (_apiKey: string, _hwid: string, _token?: string) => ({
					success: true as const,
					type: "PERPETUAL" as const,
					customFields: {},
					sessionToken: "11111111-1111-4111-8111-111111111111",
					sessionTtlSeconds: 45,
				}),
			),
		} as unknown as HandshakeService;
		const app = new Elysia().use(
			handshakePlugin(
				service,
				{ trustProxyHeaders: false, trustedProxyCidrs: [] },
				{ limiter, requestsPerMinute: 30 },
			),
		);
		for (const apiKey of ["first-secret", "second-secret"]) {
			const response = await app.handle(
				new Request("http://localhost/v1/handshake", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ apiKey, hwid: "shared-hwid" }),
				}),
			);
			expect(response.status).toBe(200);
		}
		const sessionToken = "11111111-1111-4111-8111-111111111111";
		const heartbeat = await app.handle(
			new Request("http://localhost/v1/handshake", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					apiKey: "first-secret",
					hwid: "shared-hwid",
					sessionToken,
				}),
			}),
		);
		expect(heartbeat.status).toBe(200);
		expect(consumedKeys).toHaveLength(3);
		expect(consumedKeys[0]).not.toBe(consumedKeys[1]);
		expect(consumedKeys.join(" ")).not.toContain("first-secret");
		expect(consumedKeys.join(" ")).not.toContain("second-secret");
		expect(consumedKeys.join(" ")).not.toContain(sessionToken);
	});

	test("returns Redis' exact Retry-After value", async () => {
		const redis = {
			send: mock(async () => [0, 17]),
		} as unknown as import("bun").RedisClient;
		const limiter = new RedisSlidingWindowRateLimiter(redis);
		expect(await limiter.consume("hashed-principal", 30)).toEqual({
			allowed: false,
			retryAfterSeconds: 17,
		});
	});

	test("enforces the coarse IP ceiling independently", async () => {
		const limiter = {
			consume: mock(async () => ({
				allowed: false,
				retryAfterSeconds: 9,
			})),
		} as unknown as RedisSlidingWindowRateLimiter;
		const resolver = new ClientIpResolver({
			trustProxyHeaders: false,
			trustedProxyCidrs: [],
		});
		const app = new Elysia()
			.use(rateLimiter(limiter, 6_000, resolver))
			.get("/limited", () => ({ success: true }));
		const response = await app.handle(new Request("http://localhost/limited"));
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("9");
		expect(await response.json()).toEqual({
			error: "Too Many Requests",
			code: "RATE_LIMITED",
		});
		expect(limiter.consume).toHaveBeenCalledWith(
			"ratelimit:ip:127.0.0.1",
			6_000,
		);
	});
});
