import { describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";
import { RedisDashboardSessions } from "../auth";
import {
	boundDashboardStatistics,
	createDashboardPlugin,
	DASHBOARD_MAX_CHART_POINTS,
} from "../plugin";
import {
	DashboardActivityHub,
	type DashboardApi,
	type DashboardConfig,
	type DashboardRedis,
	type DashboardStatistics,
} from "../types";

class MemoryRedis implements DashboardRedis {
	readonly values = new Map<string, string>();
	readonly attempts = new Map<string, number>();

	async send(command: string, args: string[]): Promise<unknown> {
		switch (command) {
			case "EVAL": {
				const key = args[2] as string;
				const count = (this.attempts.get(key) ?? 0) + 1;
				this.attempts.set(key, count);
				return [count, Number(args[3])];
			}
			case "SET":
				this.values.set(args[0] as string, args[1] as string);
				return "OK";
			case "GET":
				return this.values.get(args[0] as string) ?? null;
			case "DEL":
				this.values.delete(args[0] as string);
				this.attempts.delete(args[0] as string);
				return 1;
			default:
				throw new Error(`Unexpected Redis command: ${command}`);
		}
	}
}

const config: DashboardConfig = {
	username: "operator",
	password: "a-secure-dashboard-password",
	secureCookies: false,
	sessionTtlMinutes: 60,
};

function request(path: string, init?: RequestInit): Request {
	return new Request(`http://localhost${path}`, init);
}

function cookie(response: Response): string {
	return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

function fakeApi() {
	const createCustomer = mock(async (input: unknown) => ({
		id: "customer-2",
		createdAt: new Date(0),
		metadata: {},
		...(input as object),
	}));
	const customers = [
		{
			id: "customer-1",
			name: "Owner",
			email: "owner@example.com",
			metadata: {},
			createdAt: new Date(0),
		},
	];
	const statistics = mock(async () => ({
		totals: [],
		buckets: [],
		recent: [],
	}));
	return {
		createCustomer,
		statistics,
		api: {
			customers: {
				list: async () => customers,
				get: async () => customers[0],
				create: createCustomer,
				update: async (_id: string, input: unknown) => ({
					...customers[0],
					...(input as object),
				}),
				delete: async () => undefined,
			},
			licenses: {
				list: async () => [],
				get: async () => {
					throw new Error("unused");
				},
				create: async () => {
					throw new Error("unused");
				},
				update: async () => {
					throw new Error("unused");
				},
				delete: async () => undefined,
				revoke: async () => {
					throw new Error("unused");
				},
				restore: async () => {
					throw new Error("unused");
				},
				rotate: async () => ({
					licenseKey: "lic_secret",
					keyPrefix: "lic_secr",
				}),
				terminateSessions: async () => ({ terminated: 0 }),
				resetDevices: async () => ({ removed: 0 }),
				access: async () => ({
					registeredIps: [],
					registeredDevices: [],
					ipAllowlist: [],
					deviceAllowlist: [],
					attemptedIps: [],
					attemptedDevices: [],
					activeSessions: [],
				}),
				addIpAllowlist: async () => {
					throw new Error("unused");
				},
				removeIpAllowlist: async () => {
					throw new Error("unused");
				},
				addDeviceAllowlist: async () => {
					throw new Error("unused");
				},
				removeDeviceAllowlist: async () => {
					throw new Error("unused");
				},
				removeRegisteredIp: async () => {
					throw new Error("unused");
				},
				removeRegisteredDevice: async () => {
					throw new Error("unused");
				},
				meters: async () => [],
				createMeter: async () => [],
				archiveMeter: async () => [],
				adjustMeter: async () => [],
			},
			statistics,
		} as unknown as DashboardApi,
	};
}

async function login(app: ReturnType<typeof createDashboardPlugin>) {
	const response = await app.handle(
		request("/dashboard/api/login", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://localhost",
			},
			body: JSON.stringify({
				username: config.username,
				password: config.password,
			}),
		}),
	);
	const payload = (await response.json()) as { csrfToken: string };
	return { cookie: cookie(response), csrfToken: payload.csrfToken };
}

describe("Redis dashboard authentication", () => {
	test("requires separate non-empty operator credentials", () => {
		const redis = new MemoryRedis();
		expect(
			() => new RedisDashboardSessions(redis, { ...config, username: " " }),
		).toThrow("username");
		expect(
			() => new RedisDashboardSessions(redis, { ...config, password: "short" }),
		).toThrow("at least 16");
	});

	test("persists sessions in Redis so another manager can verify them", async () => {
		const redis = new MemoryRedis();
		const first = new RedisDashboardSessions(redis, config, () => 1_000);
		const result = await first.login(
			config.username,
			config.password,
			"127.0.0.1",
		);
		const second = new RedisDashboardSessions(redis, config, () => 1_001);
		const sessionCookie = result.cookie.split(";", 1).at(0) ?? "";
		const authenticated = request("/dashboard/api/session", {
			headers: { cookie: sessionCookie },
		});
		expect(await second.session(authenticated)).not.toBeNull();
		expect(
			await second.verifyCsrf(
				new Request(authenticated, {
					headers: {
						cookie: sessionCookie,
						"x-csrf-token": result.csrfToken,
					},
				}),
			),
		).toBe(true);
	});

	test("throttles login attempts in Redis", async () => {
		const sessions = new RedisDashboardSessions(new MemoryRedis(), {
			...config,
			maxLoginAttempts: 2,
		});
		await expect(sessions.login("bad", "bad", "client")).rejects.toMatchObject({
			status: 401,
		});
		await expect(sessions.login("bad", "bad", "client")).rejects.toMatchObject({
			status: 401,
		});
		await expect(
			sessions.login(config.username, config.password, "client"),
		).rejects.toMatchObject({ status: 429 });
	});
});

describe("integrated dashboard plugin", () => {
	test("serves embedded assets and keeps security headers route-scoped", async () => {
		const { api } = fakeApi();
		const plugin = createDashboardPlugin({
			api,
			activity: new DashboardActivityHub(),
			config,
			redis: new MemoryRedis(),
		});
		const parent = new Elysia()
			.get("/health", () => ({ status: "ok" }))
			.use(plugin);
		const page = await parent.handle(request("/"));
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("Realtime statistics");
		expect(page.headers.get("content-security-policy")).toContain(
			"connect-src 'self'",
		);
		const script = await parent.handle(request("/dashboard/assets/app.js"));
		expect(await script.text()).toContain("new EventSource");
		const health = await parent.handle(request("/health"));
		expect(health.headers.get("content-security-policy")).toBeNull();
	});

	test("reloads the durable statistics snapshot on every SSE ready event", async () => {
		const { api } = fakeApi();
		const app = createDashboardPlugin({
			api,
			activity: new DashboardActivityHub(),
			config,
			redis: new MemoryRedis(),
		});
		const script = await app.handle(request("/dashboard/assets/app.js"));
		const source = await script.text();
		const readyStart = source.indexOf('source.addEventListener("ready"');
		const activityStart = source.indexOf(
			'source.addEventListener("activity"',
			readyStart,
		);
		expect(readyStart).toBeGreaterThan(-1);
		expect(activityStart).toBeGreaterThan(readyStart);
		expect(source.slice(readyStart, activityStart)).toContain(
			"refreshStatisticsSnapshot()",
		);
	});

	test("exposes operator-triggered Stripe synchronization when configured", async () => {
		const { api } = fakeApi();
		const sync = mock(async () => ({ id: "license-1" }));
		api.stripe = {
			state: async () => ({ enabled: true }),
			link: async () => ({ id: "license-1" }) as never,
			sync: sync as never,
			unlink: async () => ({ id: "license-1" }) as never,
		};
		const app = createDashboardPlugin({
			api,
			activity: new DashboardActivityHub(),
			config,
			redis: new MemoryRedis(),
		});
		const operator = await login(app);
		const response = await app.handle(
			request("/dashboard/api/stripe/licenses/license-1/sync", {
				method: "POST",
				headers: {
					cookie: operator.cookie,
					origin: "http://localhost",
					"x-csrf-token": operator.csrfToken,
				},
			}),
		);
		expect(response.status).toBe(200);
		expect(sync).toHaveBeenCalledWith("license-1");
	});

	test("defaults statistics to the recent chart window", async () => {
		const now = Date.UTC(2026, 7, 15, 12, 0, 0);
		const { api, statistics } = fakeApi();
		const app = createDashboardPlugin({
			api,
			activity: new DashboardActivityHub(),
			config,
			redis: new MemoryRedis(),
			now: () => now,
		});
		const operator = await login(app);
		const response = await app.handle(
			request("/dashboard/api/statistics", {
				headers: { cookie: operator.cookie },
			}),
		);
		expect(response.status).toBe(200);
		expect(statistics).toHaveBeenCalledWith({
			from: "2026-08-14T12:00:00.000Z",
			to: "2026-08-15T12:00:00.000Z",
		});
	});

	test("requires same-origin login, a Redis session, and session CSRF", async () => {
		const { api, createCustomer } = fakeApi();
		const app = createDashboardPlugin({
			api,
			activity: new DashboardActivityHub(),
			config,
			redis: new MemoryRedis(),
		});
		const crossOrigin = await app.handle(
			request("/dashboard/api/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					username: config.username,
					password: config.password,
				}),
			}),
		);
		expect(crossOrigin.status).toBe(403);
		const unauthorized = await app.handle(request("/dashboard/api/customers"));
		expect(unauthorized.status).toBe(401);

		const operator = await login(app);
		const session = await app.handle(
			request("/dashboard/api/session", {
				headers: { cookie: operator.cookie },
			}),
		);
		expect(await session.json()).toMatchObject({
			authenticated: true,
			capabilities: { stripe: false, realtime: true },
		});

		const missingCsrf = await app.handle(
			request("/dashboard/api/customers", {
				method: "POST",
				headers: {
					cookie: operator.cookie,
					"content-type": "application/json",
					origin: "http://localhost",
				},
				body: JSON.stringify({
					name: "New owner",
					email: "new@example.com",
				}),
			}),
		);
		expect(missingCsrf.status).toBe(403);

		const created = await app.handle(
			request("/dashboard/api/customers", {
				method: "POST",
				headers: {
					cookie: operator.cookie,
					"content-type": "application/json",
					origin: "http://localhost",
					"x-csrf-token": operator.csrfToken,
				},
				body: JSON.stringify({
					name: "New owner",
					email: "new@example.com",
					metadata: { plan: "dev" },
				}),
			}),
		);
		expect(created.status).toBe(200);
		expect(createCustomer).toHaveBeenCalledWith({
			name: "New owner",
			email: "new@example.com",
			metadata: { plan: "dev" },
		});

		const legacy = await app.handle(
			request("/dashboard/api/customers", {
				method: "POST",
				headers: {
					cookie: operator.cookie,
					"content-type": "application/json",
					origin: "http://localhost",
					"x-csrf-token": operator.csrfToken,
				},
				body: JSON.stringify({
					name: "Legacy",
					email: "legacy@example.com",
					customFields: {},
				}),
			}),
		);
		expect(legacy.status).toBe(400);
		expect(await legacy.json()).toEqual({
			error:
				"Legacy field 'customFields' is not supported by the dashboard API.",
		});
	});

	test("streams the normalized activity event shape over authenticated SSE", async () => {
		const { api } = fakeApi();
		const activity = new DashboardActivityHub();
		const app = createDashboardPlugin({
			api,
			activity,
			config,
			redis: new MemoryRedis(),
		});
		const operator = await login(app);
		const response = await app.handle(
			request("/dashboard/api/events", {
				headers: { cookie: operator.cookie },
			}),
		);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Expected an SSE response body");
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toContain("event: ready");
		activity.publish({
			id: "event-1",
			type: "usage.consumed",
			source: "client",
			outcome: "success",
			licenseId: "license-1",
			keyPrefix: "lic_abcd",
			ip: "203.0.113.10",
			deviceId: "private-device",
			details: { identifier: "private-device" },
			createdAt: new Date(0),
		} as Parameters<typeof activity.publish>[0] & {
			ip: string;
			deviceId: string;
		});
		const second = await reader.read();
		const frame = new TextDecoder().decode(second.value);
		expect(frame).toContain("event: activity");
		expect(frame).toContain('"type":"usage.consumed"');
		expect(frame).not.toContain("203.0.113.10");
		expect(frame).not.toContain("private-device");
		await reader.cancel();
	});
});

describe("dashboard statistics bounds", () => {
	test("keeps lifetime totals while reducing 30 days of minutes to at most 96 chart points", () => {
		const now = Date.UTC(2026, 7, 15, 12, 0, 0);
		const minute = 60_000;
		const totals: DashboardStatistics["totals"] = [
			{
				scope: "global",
				scopeId: "",
				type: "license.heartbeat",
				count: 500_000,
			},
		];
		const buckets: DashboardStatistics["buckets"] = Array.from(
			{ length: 30 * 24 * 60 },
			(_value, index) => ({
				minute: new Date(now - index * minute),
				scope: "global" as const,
				scopeId: "",
				type: "license.heartbeat" as const,
				count: 1,
			}),
		);
		const bounded = boundDashboardStatistics(
			{ totals, buckets, recent: [] },
			now,
		);

		expect(bounded.totals).toEqual(totals);
		expect(bounded.buckets).toHaveLength(DASHBOARD_MAX_CHART_POINTS);
		expect(
			new Set(bounded.buckets.map((bucket) => String(bucket.minute))).size,
		).toBe(DASHBOARD_MAX_CHART_POINTS);
	});
});
