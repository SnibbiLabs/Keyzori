import { Elysia, t } from "elysia";
import appScript from "./public/app.js.txt" with { type: "text" };
import dashboardHtml from "./public/index.html.txt" with { type: "text" };
import dashboardStyles from "./public/styles.css.txt" with { type: "text" };
import { isSameOriginMutation, RedisDashboardSessions } from "./auth";
import {
	DashboardHttpError,
	type DashboardActivity,
	type DashboardActivityKind,
	type DashboardOptions,
	type DashboardStatistics,
} from "./types";
import {
	customerInput,
	inputObject,
	licenseInput,
	listFilters,
	meterAdjustment,
	meterCreation,
	stringBody,
} from "./validation";

const encoder = new TextEncoder();

export const DASHBOARD_STATISTICS_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const DASHBOARD_CHART_INTERVAL_MS = 15 * 60 * 1_000;
export const DASHBOARD_MAX_CHART_POINTS = 96;

const DASHBOARD_CHART_ACTIVITY_TYPES = new Set<DashboardActivityKind>([
	"license.activation_attempted",
	"license.heartbeat",
	"usage.consumed",
]);

export function boundDashboardStatistics(
	statistics: DashboardStatistics,
	now: number,
): DashboardStatistics {
	const cutoff = now - DASHBOARD_STATISTICS_WINDOW_MS;
	const grouped = new Map<
		string,
		DashboardStatistics["buckets"][number] & { interval: number }
	>();
	const intervals = new Set<number>();

	for (const bucket of statistics.buckets) {
		if (!DASHBOARD_CHART_ACTIVITY_TYPES.has(bucket.type)) continue;
		const timestamp = new Date(bucket.minute).getTime();
		if (!Number.isFinite(timestamp) || timestamp < cutoff || timestamp > now) {
			continue;
		}
		const interval =
			Math.floor(timestamp / DASHBOARD_CHART_INTERVAL_MS) *
			DASHBOARD_CHART_INTERVAL_MS;
		const key = [interval, bucket.scope, bucket.scopeId, bucket.type].join(":");
		const existing = grouped.get(key);
		if (existing) {
			existing.count += Number(bucket.count);
		} else {
			grouped.set(key, {
				...bucket,
				minute: new Date(interval),
				count: Number(bucket.count),
				interval,
			});
		}
		intervals.add(interval);
	}

	const visibleIntervals = new Set(
		[...intervals]
			.sort((left, right) => left - right)
			.slice(-DASHBOARD_MAX_CHART_POINTS),
	);
	const buckets = [...grouped.values()]
		.filter((bucket) => visibleIntervals.has(bucket.interval))
		.sort(
			(left, right) =>
				left.interval - right.interval || left.type.localeCompare(right.type),
		)
		.map(({ interval: _interval, ...bucket }) => bucket);

	return {
		...statistics,
		buckets,
		recent: statistics.recent.slice(0, 100),
	};
}

function applySecurityHeaders(
	headers: Record<string, string | number>,
	secureCookies: boolean,
): void {
	headers["cache-control"] = "no-store";
	headers["content-security-policy"] =
		"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
	headers["cross-origin-opener-policy"] = "same-origin";
	headers["cross-origin-resource-policy"] = "same-origin";
	headers["permissions-policy"] = "camera=(), geolocation=(), microphone=()";
	headers["referrer-policy"] = "no-referrer";
	headers["x-content-type-options"] = "nosniff";
	headers["x-frame-options"] = "DENY";
	if (secureCookies) {
		headers["strict-transport-security"] = "max-age=31536000";
	}
}

function exposedError(error: unknown): { status: number; message: string } {
	if (error instanceof DashboardHttpError) {
		return { status: error.status, message: error.message };
	}
	if (error && typeof error === "object" && "statusCode" in error) {
		const status = Number(error.statusCode);
		if (status >= 400 && status < 500) {
			return {
				status,
				message:
					error instanceof Error ? error.message : "Dashboard request failed.",
			};
		}
	}
	return { status: 500, message: "Internal Server Error" };
}

function sseFrame(activity: DashboardActivity): Uint8Array {
	const safe = publicActivity(activity);
	const id = safe.id.replace(/[\r\n]/g, "");
	return encoder.encode(
		`id: ${id}\nevent: activity\ndata: ${JSON.stringify(safe)}\n\n`,
	);
}

function publicActivity(activity: DashboardActivity): DashboardActivity {
	return {
		id: activity.id,
		type: activity.type,
		source: activity.source,
		outcome: activity.outcome,
		reason: activity.reason ?? null,
		licenseId: activity.licenseId ?? null,
		customerId: activity.customerId ?? null,
		keyPrefix: activity.keyPrefix?.slice(0, 16) ?? null,
		createdAt: activity.createdAt,
	};
}

function activityStream(
	options: DashboardOptions,
	request: Request,
	expiresAt: number,
): Response {
	let dispose: (() => void) | undefined;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			const cleanup = () => {
				if (closed) return;
				closed = true;
				clearInterval(heartbeat);
				clearTimeout(expiry);
				unsubscribe();
			};
			const end = () => {
				if (closed) return;
				cleanup();
				try {
					controller.close();
				} catch {
					// The transport may already have closed the stream.
				}
			};
			const unsubscribe = options.activity.subscribe((activity) => {
				if (!closed) controller.enqueue(sseFrame(activity));
			});
			const heartbeat = setInterval(() => {
				if (!closed) controller.enqueue(encoder.encode(": keepalive\n\n"));
			}, 15_000);
			const expiry = setTimeout(
				end,
				Math.max(
					1,
					Math.min(2_147_483_647, expiresAt - (options.now?.() ?? Date.now())),
				),
			);
			controller.enqueue(encoder.encode("event: ready\ndata: {}\n\n"));
			request.signal.addEventListener("abort", end, { once: true });
			dispose = cleanup;
		},
		cancel() {
			dispose?.();
		},
	});
	return new Response(stream, {
		headers: {
			"cache-control": "no-cache, no-store",
			connection: "keep-alive",
			"content-type": "text/event-stream; charset=utf-8",
			"x-accel-buffering": "no",
		},
	});
}

export function createDashboardPlugin(options: DashboardOptions) {
	const sessions = new RedisDashboardSessions(
		options.redis,
		options.config,
		options.now,
	);
	const clientIp = (
		request: Request,
		server: { requestIP(request: Request): { address: string } | null } | null,
	) =>
		options.resolveClientIp?.(request, server) ??
		server?.requestIP(request)?.address ??
		"unknown";
	const requireOperator = async ({
		request,
		set,
	}: {
		request: Request;
		set: { status?: number | string };
	}) => {
		if (!(await sessions.session(request))) {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		if (!isSameOriginMutation(request)) {
			set.status = 403;
			return { error: "Cross-origin request rejected" };
		}
		if (
			!["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase()) &&
			!(await sessions.verifyCsrf(request))
		) {
			set.status = 403;
			return { error: "Invalid CSRF token" };
		}
	};

	const dashboard = new Elysia({
		name: "keyzori-dashboard",
		detail: { hide: true },
	})
		.onBeforeHandle(({ set }) => {
			applySecurityHeaders(
				set.headers as Record<string, string | number>,
				options.config.secureCookies,
			);
		})
		.onError(({ error, set }) => {
			const exposed = exposedError(error);
			set.status = exposed.status;
			if (exposed.status >= 500) {
				console.error(
					JSON.stringify({
						level: "error",
						event: "dashboard_request_failed",
						message: error instanceof Error ? error.message : "Unknown error",
					}),
				);
			}
			return { error: exposed.message };
		})
		.get(
			"/",
			() =>
				new Response(dashboardHtml, {
					headers: { "content-type": "text/html; charset=utf-8" },
				}),
		)
		.get(
			"/dashboard/assets/styles.css",
			() =>
				new Response(dashboardStyles, {
					headers: { "content-type": "text/css; charset=utf-8" },
				}),
		)
		.get(
			"/dashboard/assets/app.js",
			() =>
				new Response(appScript, {
					headers: { "content-type": "text/javascript; charset=utf-8" },
				}),
		)
		.get("/dashboard/api/session", async ({ request }) => {
			const session = await sessions.session(request);
			return {
				authenticated: Boolean(session),
				csrfToken: session?.csrfToken ?? null,
				capabilities: session
					? { stripe: options.api.stripe !== undefined, realtime: true }
					: null,
			};
		})
		.post(
			"/dashboard/api/login",
			async ({ body, request, server, set }) => {
				if (!isSameOriginMutation(request)) {
					set.status = 403;
					return { error: "Cross-origin request rejected" };
				}
				const input = inputObject(body);
				const username = input.username;
				const password = input.password;
				if (typeof username !== "string" || typeof password !== "string") {
					throw new DashboardHttpError(
						400,
						"username and password are required.",
					);
				}
				const result = await sessions.login(
					username,
					password,
					clientIp(request, server),
				);
				set.headers["set-cookie"] = result.cookie;
				return { authenticated: true as const, csrfToken: result.csrfToken };
			},
			{ body: t.Any() },
		)
		.group("/dashboard/api", { beforeHandle: requireOperator }, (app) =>
			app
				.post("/logout", async ({ request, set }) => {
					set.headers["set-cookie"] = await sessions.logout(request);
					return { authenticated: false as const };
				})
				.get("/events", async ({ request, set }) => {
					const session = await sessions.session(request);
					if (!session) {
						set.status = 401;
						return { error: "Unauthorized" };
					}
					return activityStream(options, request, session.expiresAt);
				})
				.get("/customers", ({ request }) =>
					options.api.customers.list(listFilters(request)),
				)
				.get("/customers/:id", ({ params }) =>
					options.api.customers.get(params.id),
				)
				.post(
					"/customers",
					({ body }) => options.api.customers.create(customerInput(body)),
					{ body: t.Any() },
				)
				.patch(
					"/customers/:id",
					({ params, body }) =>
						options.api.customers.update(params.id, customerInput(body, true)),
					{ body: t.Any() },
				)
				.delete("/customers/:id", async ({ params, set }) => {
					await options.api.customers.delete(params.id);
					set.status = 204;
				})
				.get("/licenses", ({ request }) =>
					options.api.licenses.list(listFilters(request)),
				)
				.get("/licenses/:id", ({ params }) =>
					options.api.licenses.get(params.id),
				)
				.post(
					"/licenses",
					({ body }) => options.api.licenses.create(licenseInput(body)),
					{ body: t.Any() },
				)
				.patch(
					"/licenses/:id",
					({ params, body }) =>
						options.api.licenses.update(params.id, licenseInput(body, true)),
					{ body: t.Any() },
				)
				.delete("/licenses/:id", async ({ params, set }) => {
					await options.api.licenses.delete(params.id);
					set.status = 204;
				})
				.post(
					"/licenses/:id/revoke",
					({ params, body }) =>
						options.api.licenses.revoke(
							params.id,
							stringBody(body, "reason", 500),
						),
					{ body: t.Any() },
				)
				.post("/licenses/:id/restore", ({ params }) =>
					options.api.licenses.restore(params.id),
				)
				.post("/licenses/:id/rotate", ({ params }) =>
					options.api.licenses.rotate(params.id),
				)
				.post("/licenses/:id/sessions/terminate", ({ params }) =>
					options.api.licenses.terminateSessions(params.id),
				)
				.post("/licenses/:id/devices/reset", ({ params }) =>
					options.api.licenses.resetDevices(params.id),
				)
				.get("/licenses/:id/access", ({ params }) =>
					options.api.licenses.access(params.id),
				)
				.post(
					"/licenses/:id/access/ip-allowlist",
					({ params, body }) =>
						options.api.licenses.addIpAllowlist(
							params.id,
							stringBody(body, "value", 45),
						),
					{ body: t.Any() },
				)
				.delete("/licenses/:id/access/ip-allowlist/:value", ({ params }) =>
					options.api.licenses.removeIpAllowlist(params.id, params.value),
				)
				.post(
					"/licenses/:id/access/device-allowlist",
					({ params, body }) =>
						options.api.licenses.addDeviceAllowlist(
							params.id,
							stringBody(body, "deviceId", 256),
						),
					{ body: t.Any() },
				)
				.delete(
					"/licenses/:id/access/device-allowlist/:deviceId",
					({ params }) =>
						options.api.licenses.removeDeviceAllowlist(
							params.id,
							params.deviceId,
						),
				)
				.delete("/licenses/:id/access/registered-ips/:value", ({ params }) =>
					options.api.licenses.removeRegisteredIp(params.id, params.value),
				)
				.delete(
					"/licenses/:id/access/registered-devices/:deviceId",
					({ params }) =>
						options.api.licenses.removeRegisteredDevice(
							params.id,
							params.deviceId,
						),
				)
				.get("/licenses/:id/meters", ({ params }) =>
					options.api.licenses.meters(params.id),
				)
				.post(
					"/licenses/:id/meters",
					({ params, body }) =>
						options.api.licenses.createMeter(params.id, meterCreation(body)),
					{ body: t.Any() },
				)
				.post(
					"/licenses/:id/meters/:name/archive",
					({ params, body }) =>
						options.api.licenses.archiveMeter(
							params.id,
							params.name,
							stringBody(body, "reason", 500),
						),
					{ body: t.Any() },
				)
				.post(
					"/licenses/:id/meters/:name/adjust",
					({ params, body }) =>
						options.api.licenses.adjustMeter(
							params.id,
							params.name,
							meterAdjustment(body),
						),
					{ body: t.Any() },
				)
				.get("/statistics", async ({ request }) => {
					const now = options.now?.() ?? Date.now();
					const filters = listFilters(request);
					const earliest = now - DASHBOARD_STATISTICS_WINDOW_MS;
					const requestedFrom = filters.from
						? Date.parse(filters.from)
						: Number.NaN;
					if (
						!filters.from ||
						(Number.isFinite(requestedFrom) && requestedFrom < earliest)
					) {
						filters.from = new Date(earliest).toISOString();
					}
					filters.to ??= new Date(now).toISOString();
					const statistics = boundDashboardStatistics(
						await options.api.statistics(filters),
						now,
					);
					return {
						...statistics,
						recent: statistics.recent.map(publicActivity),
					};
				}),
		);

	if (options.api.stripe) {
		const stripe = options.api.stripe;
		dashboard.group(
			"/dashboard/api/stripe",
			{ beforeHandle: requireOperator },
			(app) =>
				app
					.get("/state", () => stripe.state())
					.post(
						"/licenses/:id/link",
						({ params, body }) =>
							stripe.link(params.id, stringBody(body, "subscriptionId", 255)),
						{ body: t.Any() },
					)
					.post("/licenses/:id/sync", ({ params }) => stripe.sync(params.id))
					.delete("/licenses/:id/link", ({ params }) =>
						stripe.unlink(params.id),
					),
		);
	}

	return dashboard;
}
