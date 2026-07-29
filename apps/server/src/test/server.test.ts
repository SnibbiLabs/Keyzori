import { describe, expect, it, mock } from "bun:test";

mock.module("../db", () => {
	return {
		db: { execute: mock(async () => []) },
	};
});

export let rateLimitCount = 0;
const mockRedis = {
	zremrangebyscore: mock(async () => {}),
	zcard: mock(async () => rateLimitCount),
	zadd: mock(async () => {}),
	expire: mock(async () => {}),
	set: mock(async () => {}),
	sadd: mock(async () => {}),
	smembers: mock(async () => []),
	exists: mock(async () => false),
	srem: mock(async () => {}),
	scard: mock(async () => 1),
	del: mock(async () => {}),
	ping: mock(async () => "PONG"),
	send: mock(async (_command: string, args: string[]) =>
		rateLimitCount >= Number(args[6]) ? [0, 1] : [1, 0],
	),
};

import { createServer } from "../index";
import { DomainError } from "../domain/errors";

const app = createServer(mockRedis as unknown as import("bun").RedisClient);

describe("Keyzori Server Comprehensive Operations", () => {
	it("exposes a health endpoint", async () => {
		const response = await app.handle(
			new Request("http://localhost:3000/health"),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("x-frame-options")).toBe("DENY");
	});

	it("exposes dependency readiness", async () => {
		rateLimitCount = 60;
		const response = await app.handle(
			new Request("http://localhost:3000/ready"),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ready" });
		rateLimitCount = 0;
	});

	it("reports dependency unavailability", async () => {
		mockRedis.ping.mockRejectedValueOnce(new Error("Redis unavailable"));
		const response = await app.handle(
			new Request("http://localhost:3000/ready"),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ status: "unavailable" });
	});

	it("publishes themed Scalar UI and a complete OpenAPI specification", async () => {
		const docs = await app.handle(new Request("http://localhost:3000/docs"));
		expect(docs.status).toBe(200);
		const docsHtml = await docs.text();
		expect(docsHtml).toContain('id="api-reference"');
		expect(docsHtml).toContain("--keyzori-docs-theme: monochrome");
		expect(docsHtml).toContain('"darkMode":true');
		expect(docsHtml).toContain("@scalar/api-reference@1.62.9");

		const specification = await app.handle(
			new Request("http://localhost:3000/docs/openapi.json"),
		);
		expect(specification.status).toBe(200);
		const document = (await specification.json()) as {
			info: {
				title: string;
				description?: string;
				license?: { name?: string };
			};
			paths: Record<
				string,
				Record<
					string,
					{
						operationId?: string;
						security?: Array<Record<string, string[]>>;
						responses?: Record<string, unknown>;
						requestBody?: {
							content?: Record<
								string,
								{
									schema?: {
										description?: string;
										examples?: unknown[];
										properties?: Record<
											string,
											{
												description?: string;
												default?: unknown;
												examples?: unknown[];
											}
										>;
									};
								}
							>;
						};
					}
				>
			>;
			components: { securitySchemes: Record<string, unknown> };
		};
		expect(document.info.title).toBe("Keyzori License Server API");
		expect(document.info.license?.name).toBe("Apache License 2.0");
		for (const setting of [
			"DATABASE_URL",
			"REDIS_URL",
			"ADMIN_API_KEY",
			"ADMIN_API_KEYS",
			"HOST",
			"PORT",
			"TRUST_PROXY_HEADERS",
			"TRUSTED_PROXY_HEADER",
			"TRUSTED_PROXY_CIDRS",
			"OPENAPI_ENABLED",
			"RATE_LIMIT_PER_MINUTE",
			"LICENSE_RATE_LIMIT_PER_MINUTE",
			"RATE_LIMIT_PER_IP_PER_MINUTE",
			"MAX_REQUEST_BODY_BYTES",
			"DRIZZLE_MIGRATIONS_PATH",
		]) {
			expect(document.info.description).toContain(`\`${setting}\``);
		}
		expect(document.info.description).toContain("TypeScript SDK configuration");
		expect(document.info.description).toContain("Complete license examples");
		expect(document.paths["/v1/handshake"]).toBeDefined();
		expect(document.paths["/admin/keys"]).toBeDefined();
		expect(
			document.paths["/admin/users"]?.post?.responses?.["409"],
		).toBeDefined();
		expect(document.components.securitySchemes.AdminKey).toBeDefined();

		const handshake = document.paths["/v1/handshake"]?.post;
		expect(handshake?.operationId).toBe("handshakeLicense");
		expect(handshake?.responses?.["429"]).toBeDefined();
		expect(handshake?.responses?.["500"]).toBeDefined();
		const handshakeProperties =
			handshake?.requestBody?.content?.["application/json"]?.schema?.properties;
		expect(handshakeProperties?.apiKey).toMatchObject({
			minLength: 1,
			maxLength: 128,
			description: expect.any(String),
			examples: expect.any(Array),
		});

		const createKey = document.paths["/admin/keys"]?.post;
		expect(createKey?.operationId).toBe("createKey");
		expect(createKey?.security).toEqual([{ AdminKey: [] }]);
		expect(createKey?.responses?.["401"]).toBeDefined();
		expect(createKey?.responses?.["429"]).toBeDefined();
		const createKeySchema =
			createKey?.requestBody?.content?.["application/json"]?.schema;
		expect(createKeySchema?.examples).toHaveLength(3);
		const configurableFields = [
			"userId",
			"limitIp",
			"limitHwid",
			"limitConcurrent",
			"limitUsage",
			"trialDurationMin",
			"customFields",
			"expiresAt",
		];
		expect(
			configurableFields.filter(
				(field) => !createKeySchema?.properties?.[field]?.description,
			),
		).toEqual([]);
		expect(createKeySchema?.properties?.type).toBeDefined();
		expect(createKeySchema?.properties?.limitIp?.default).toBe(0);
		expect(createKeySchema?.properties?.limitHwid?.examples).toContain(1);
		expect(createKeySchema?.properties?.customFields?.default).toEqual({});
	});

	it("Validates rate limiting logic", async () => {
		rateLimitCount = 60;
		const res = await app.handle(
			new Request("http://localhost:3000/v1/handshake", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					apiKey: "sk_test_123",
					hwid: "hwid1",
				}),
			}),
		);
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({
			error: "Too Many Requests",
			code: "RATE_LIMITED",
		});
		expect(res.headers.get("retry-after")).toBe("1");
	});

	it("returns a safe JSON response for unexpected failures", async () => {
		rateLimitCount = 0;
		mockRedis.send.mockRejectedValueOnce(new Error("sensitive Redis detail"));
		const response = await app.handle(
			new Request("http://localhost:3000/v1/handshake", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					apiKey: "sk_test_123",
					hwid: "hwid1",
				}),
			}),
		);

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: "Internal Server Error",
			code: "INTERNAL_ERROR",
		});
	});

	it("maps uncaught domain errors at the server boundary", async () => {
		const domainErrorApp = createServer(
			mockRedis as unknown as import("bun").RedisClient,
		).get("/__test_domain_error", () => {
			throw new DomainError("Safe domain failure", 409);
		});
		const response = await domainErrorApp.handle(
			new Request("http://localhost:3000/__test_domain_error"),
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "Safe domain failure",
			code: "INVALID_REQUEST",
		});
	});

	it("Blocks unauthorized admin access", async () => {
		rateLimitCount = 0;
		const res = await app.handle(
			new Request("http://localhost:3000/admin/keys", {
				method: "GET",
			}),
		);
		expect(res.status).toBe(401);
	});

	it("Requires strict payload validation for handshake", async () => {
		mockRedis.zcard.mockResolvedValueOnce(0); // Valid rate limit
		const res = await app.handle(
			new Request("http://localhost:3000/v1/handshake", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ apiKey: "missing_hwid" }),
			}),
		);
		expect(res.status).toBe(400);
	});
});
