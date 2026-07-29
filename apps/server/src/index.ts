import { RedisClient } from "bun";
import { openapi } from "@elysia/openapi";
import { sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import {
	createAdminService,
	createHandshakeService,
} from "./composition/services";
import { adminPlugin } from "./controllers/admin";
import { handshakePlugin } from "./controllers/handshake";
import { loadServerConfig, type ServerConfig } from "./config";
import { db } from "./db";
import { migrateDatabase } from "./db/migrate";
import { DomainError } from "./domain/errors";
import { RedisSessionRepository } from "./infrastructure/repositories/RedisSessionRepository";
import { openApiDescription } from "./openapi/documentation";
import { scalarThemeCss } from "./openapi/theme";
import { createRateLimitDependencies, rateLimiter } from "./plugins/ratelimit";
import { version } from "../package.json";

export const createServer = (redis: RedisClient, config?: ServerConfig) => {
	const trustProxyHeaders =
		config?.trustProxyHeaders ?? Bun.env.TRUST_PROXY_HEADERS === "true";
	const trustedProxyCidrs =
		config?.trustedProxyCidrs ??
		(Bun.env.TRUSTED_PROXY_CIDRS ?? "")
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean);
	const trustedProxyHeader =
		config?.trustedProxyHeader ??
		(Bun.env.TRUSTED_PROXY_HEADER === "cf-connecting-ip"
			? "cf-connecting-ip"
			: "x-forwarded-for");
	const clientIpOptions = {
		trustProxyHeaders,
		trustedProxyCidrs,
		trustedProxyHeader,
	} as const;
	const adminRequestsPerMinute =
		config?.rateLimitPerMinute ?? Number(Bun.env.RATE_LIMIT_PER_MINUTE ?? 60);
	const licenseRequestsPerMinute =
		config?.licenseRateLimitPerMinute ??
		Number(Bun.env.LICENSE_RATE_LIMIT_PER_MINUTE ?? 30);
	const ipRequestsPerMinute =
		config?.rateLimitPerIpPerMinute ??
		Number(Bun.env.RATE_LIMIT_PER_IP_PER_MINUTE ?? 6_000);
	const { limiter, clientIpResolver } = createRateLimitDependencies(
		redis,
		clientIpOptions,
	);
	const sessionRepository = new RedisSessionRepository(redis);

	const adminService = createAdminService();
	const handshakeService = createHandshakeService(sessionRepository);

	return new Elysia()
		.use(
			openapi({
				enabled: config?.openapiEnabled ?? Bun.env.OPENAPI_ENABLED !== "false",
				path: "/docs",
				specPath: "/docs/openapi.json",
				provider: "scalar",
				scalar: {
					agent: {
						disabled: true,
					},
					version: "1.62.9",
					theme: "none",
					layout: "modern",
					darkMode: true,
					showDeveloperTools: false,
					hideDarkModeToggle: true,
					showSidebar: true,
					hideModels: false,
					hideSearch: true,
					hideDownloadButton: false,
					hideTestRequestButton: true,
					withDefaultFonts: false,
					defaultOpenAllTags: false,
					mcp: {
						name: "My API",
						url: "https://mcp.example.com",
						disabled: true,
					},
					defaultHttpClient: {
						targetKey: "shell",
						clientKey: "curl",
					},
					customCss: scalarThemeCss,
				},
				documentation: {
					info: {
						title: "Keyzori License Server API",
						version,
						description: openApiDescription,
						license: {
							name: "Apache License 2.0",
							url: "https://www.apache.org/licenses/LICENSE-2.0",
						},
					},
					servers: [
						{
							url: "/",
							description: "Current Keyzori License Server",
						},
					],
					tags: [
						{
							name: "System",
							description: "Health and operational readiness.",
						},
						{
							name: "Admin",
							description:
								"Create, inspect, update, and delete owners and licenses. Requires X-Admin-Key.",
						},
						{
							name: "License",
							description:
								"Runtime handshake, heartbeat, and logout operations used by the SDK.",
						},
					],
					components: {
						securitySchemes: {
							AdminKey: {
								type: "apiKey",
								in: "header",
								name: "X-Admin-Key",
								description:
									"Administrative credential configured through ADMIN_API_KEY.",
							},
						},
					},
				},
			}),
		)
		.onError(({ code, error, set }) => {
			if (error instanceof DomainError) {
				set.status = error.statusCode;
				return { error: error.message, code: error.code };
			}
			if (code === "INTERNAL_SERVER_ERROR" || code === "UNKNOWN") {
				console.error(
					JSON.stringify({ level: "error", event: "request_failed", code }),
				);
				set.status = 500;
				return {
					error: "Internal Server Error",
					code: "INTERNAL_ERROR" as const,
				};
			}
		})
		.onAfterHandle(({ set }) => {
			set.headers["x-content-type-options"] = "nosniff";
			set.headers["x-frame-options"] = "DENY";
			set.headers["referrer-policy"] = "no-referrer";
			set.headers["cache-control"] = "no-store";
		})
		.get("/health", () => ({ status: "ok" as const }), {
			response: t.Object({ status: t.Literal("ok") }),
			detail: {
				operationId: "getHealth",
				summary: "Check service liveness",
				description:
					"Checks the server process without querying PostgreSQL or Redis.",
				tags: ["System"],
			},
		})
		.use(rateLimiter(limiter, ipRequestsPerMinute, clientIpResolver))
		.get(
			"/ready",
			async ({ set }) => {
				try {
					await Promise.all([db.execute(sql`select 1`), redis.ping()]);
					return { status: "ready" as const };
				} catch {
					set.status = 503;
					return { status: "unavailable" as const };
				}
			},
			{
				response: {
					200: t.Object({ status: t.Literal("ready") }),
					503: t.Object({ status: t.Literal("unavailable") }),
				},
				detail: {
					operationId: "getReadiness",
					summary: "Check database and Redis readiness",
					description:
						"Returns ready only after both PostgreSQL and Redis respond.",
					tags: ["System"],
				},
			},
		)
		.use(
			handshakePlugin(handshakeService, clientIpOptions, {
				limiter,
				requestsPerMinute: licenseRequestsPerMinute,
			}),
		)
		.use(
			adminPlugin(
				adminService,
				config
					? [config.adminApiKey, ...config.additionalAdminApiKeys]
					: undefined,
				{
					limiter,
					clientIpResolver,
					requestsPerMinute: adminRequestsPerMinute,
				},
			),
		);
};

async function runHealthcheck(): Promise<never> {
	try {
		const port = Bun.env.PORT ?? "3000";
		const response = await fetch(`http://127.0.0.1:${port}/ready`);
		process.exit(response.ok ? 0 : 1);
	} catch {
		process.exit(1);
	}
}

async function main(): Promise<void> {
	if (process.argv.includes("--healthcheck")) await runHealthcheck();
	const config = loadServerConfig();

	await migrateDatabase();
	const redis = new RedisClient(config.redisUrl);
	await redis.connect();
	const app = createServer(redis, config).listen({
		hostname: config.host,
		port: config.port,
		maxRequestBodySize: config.maxRequestBodyBytes,
	});
	let shuttingDown = false;
	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`Received ${signal}; shutting down.`);
		await app.stop();
		redis.close();
		await db.$client.close({ timeout: 5 });
	};
	process.once("SIGINT", () => void shutdown("SIGINT"));
	process.once("SIGTERM", () => void shutdown("SIGTERM"));
	console.log(
		`Keyzori License Server is running at ${app.server?.hostname}:${app.server?.port}`,
	);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
