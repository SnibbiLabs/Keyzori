import { timingSafeEqual } from "node:crypto";
import Elysia, { type Context, t } from "elysia";
import type { AdminService } from "../application/services/AdminService";
import type { ClientIpResolver } from "./clientIp";
import { DomainError } from "../domain/errors";
import {
	enforceRateLimit,
	type RedisSlidingWindowRateLimiter,
} from "../plugins/ratelimit";
import {
	AdminCreateKeyInputSchema,
	AdminCreateUserInputSchema,
	AdminUpdateKeyInputSchema,
	AdminUpdateUserInputSchema,
	ApiKeyResponseSchema,
	ErrorResponseSchema,
	SuccessResponseSchema,
	UserResponseSchema,
} from "./validation";

function configuredAdminKeys(): string[] {
	return [Bun.env.ADMIN_API_KEY, ...(Bun.env.ADMIN_API_KEYS ?? "").split(",")]
		.map((key) => key?.trim())
		.filter((key): key is string => Boolean(key));
}

export const createAdminAuthMiddleware =
	(expectedKeys: readonly string[] = configuredAdminKeys()) =>
	({ request, set }: Context) => {
		const adminKey = request.headers.get("X-Admin-Key");
		const suppliedDigest = adminKey
			? new Bun.CryptoHasher("sha256").update(adminKey).digest()
			: null;
		const authenticated = expectedKeys.some((expectedKey) => {
			if (!suppliedDigest) return false;
			const expectedDigest = new Bun.CryptoHasher("sha256")
				.update(expectedKey)
				.digest();
			return timingSafeEqual(expectedDigest, suppliedDigest);
		});
		if (!adminKey || !authenticated) {
			set.status = 401;
			return { error: "Unauthorized", code: "UNAUTHORIZED" as const };
		}
	};

export interface AdminRateLimitOptions {
	limiter: RedisSlidingWindowRateLimiter;
	clientIpResolver: ClientIpResolver;
	requestsPerMinute: number;
}

export const adminPlugin = (
	adminService: AdminService,
	adminApiKeys?: readonly string[],
	rateLimitOptions?: AdminRateLimitOptions,
) =>
	new Elysia({ prefix: "/admin", tags: ["Admin"] })
		.onError(({ code, error, set }) => {
			if (error instanceof DomainError) {
				set.status = error.statusCode;
				return { error: error.message, code: error.code };
			}
			if (code === "VALIDATION") {
				set.status = 400;
				return { error: error.message, code: "INVALID_REQUEST" as const };
			}
		})
		.onBeforeHandle(async ({ request, server, set }) => {
			if (!rateLimitOptions) return;
			const ip = rateLimitOptions.clientIpResolver.resolve(request, server);
			return await enforceRateLimit(
				rateLimitOptions.limiter,
				`ratelimit:admin:${ip}`,
				rateLimitOptions.requestsPerMinute,
				set,
			);
		})
		.onBeforeHandle(createAdminAuthMiddleware(adminApiKeys))
		.post(
			"/users",
			async ({ body, set }) => {
				set.status = 201;
				return await adminService.createUser(
					body.email,
					body.name,
					body.customFields,
				);
			},
			{
				body: AdminCreateUserInputSchema,
				response: {
					201: UserResponseSchema,
					400: ErrorResponseSchema,
					401: ErrorResponseSchema,
					409: ErrorResponseSchema,
					429: ErrorResponseSchema,
					500: ErrorResponseSchema,
				},
				detail: {
					operationId: "createUser",
					summary: "Create a license owner",
					description: "Creates the user that owns one or more license keys.",
					security: [{ AdminKey: [] }],
				},
			},
		)
		.get("/users", async () => await adminService.listUsers(), {
			response: {
				200: t.Array(UserResponseSchema),
				401: ErrorResponseSchema,
				429: ErrorResponseSchema,
				500: ErrorResponseSchema,
			},
			detail: {
				operationId: "listUsers",
				summary: "List license owners",
				security: [{ AdminKey: [] }],
			},
		})
		.get(
			"/users/:id",
			async ({ params }) => await adminService.getUser(params.id),
			{
				params: t.Object({ id: t.String({ minLength: 1 }) }),
				response: {
					200: UserResponseSchema,
					401: ErrorResponseSchema,
					404: ErrorResponseSchema,
					429: ErrorResponseSchema,
					500: ErrorResponseSchema,
				},
				detail: {
					operationId: "getUser",
					summary: "Get a license owner",
					security: [{ AdminKey: [] }],
				},
			},
		)
		.patch(
			"/users/:id",
			async ({ params, body }) =>
				await adminService.updateUser(params.id, body),
			{
				params: t.Object({ id: t.String({ minLength: 1 }) }),
				body: AdminUpdateUserInputSchema,
				response: {
					200: UserResponseSchema,
					400: ErrorResponseSchema,
					401: ErrorResponseSchema,
					404: ErrorResponseSchema,
					409: ErrorResponseSchema,
					429: ErrorResponseSchema,
					500: ErrorResponseSchema,
				},
				detail: {
					operationId: "updateUser",
					summary: "Update a license owner",
					security: [{ AdminKey: [] }],
				},
			},
		)
		.delete(
			"/users/:id",
			async ({ params }) => {
				await adminService.deleteUser(params.id);
				return { success: true as const };
			},
			{
				params: t.Object({ id: t.String({ minLength: 1 }) }),
				response: {
					200: SuccessResponseSchema,
					401: ErrorResponseSchema,
					404: ErrorResponseSchema,
					429: ErrorResponseSchema,
					500: ErrorResponseSchema,
				},
				detail: {
					operationId: "deleteUser",
					summary: "Delete a license owner and their licenses",
					security: [{ AdminKey: [] }],
				},
			},
		)
		.post(
			"/keys",
			async ({ body, set }) => {
				set.status = 201;
				return await adminService.createKey(body);
			},
			{
				body: AdminCreateKeyInputSchema,
				response: {
					201: ApiKeyResponseSchema,
					400: ErrorResponseSchema,
					401: ErrorResponseSchema,
					404: ErrorResponseSchema,
					429: ErrorResponseSchema,
					500: ErrorResponseSchema,
				},
				detail: {
					operationId: "createKey",
					summary: "Create a license key",
					description:
						"Creates a key and returns its secret. Store the secret securely.",
					security: [{ AdminKey: [] }],
				},
			},
		)
		.get("/keys", async () => await adminService.listKeys(), {
			response: {
				200: t.Array(ApiKeyResponseSchema),
				401: ErrorResponseSchema,
				429: ErrorResponseSchema,
				500: ErrorResponseSchema,
			},
			detail: {
				operationId: "listKeys",
				summary: "List license keys",
				description:
					"Lists license metadata with masked secrets. Full secrets are returned only at creation time.",
				security: [{ AdminKey: [] }],
			},
		})
		.get(
			"/keys/:id",
			async ({ params }) => await adminService.getKey(params.id),
			{
				params: t.Object({ id: t.String({ minLength: 1 }) }),
				response: {
					200: ApiKeyResponseSchema,
					401: ErrorResponseSchema,
					404: ErrorResponseSchema,
					429: ErrorResponseSchema,
					500: ErrorResponseSchema,
				},
				detail: {
					operationId: "getKey",
					summary: "Get a license key",
					security: [{ AdminKey: [] }],
				},
			},
		)
		.put(
			"/keys/:id",
			async ({ params, body }) => await adminService.updateKey(params.id, body),
			{
				params: t.Object({ id: t.String({ minLength: 1 }) }),
				body: AdminUpdateKeyInputSchema,
				response: {
					200: ApiKeyResponseSchema,
					400: ErrorResponseSchema,
					401: ErrorResponseSchema,
					404: ErrorResponseSchema,
					429: ErrorResponseSchema,
					500: ErrorResponseSchema,
				},
				detail: {
					operationId: "updateKey",
					summary: "Update a license key",
					security: [{ AdminKey: [] }],
				},
			},
		)
		.patch(
			"/keys/:id",
			async ({ params }) => await adminService.revokeKey(params.id),
			{
				params: t.Object({ id: t.String({ minLength: 1 }) }),
				response: {
					200: ApiKeyResponseSchema,
					401: ErrorResponseSchema,
					404: ErrorResponseSchema,
					429: ErrorResponseSchema,
					500: ErrorResponseSchema,
				},
				detail: {
					operationId: "revokeKey",
					summary: "Revoke a license key",
					security: [{ AdminKey: [] }],
				},
			},
		)
		.delete(
			"/keys/:id",
			async ({ params }) => {
				await adminService.deleteKey(params.id);
				return { success: true as const };
			},
			{
				params: t.Object({ id: t.String({ minLength: 1 }) }),
				response: {
					200: SuccessResponseSchema,
					401: ErrorResponseSchema,
					404: ErrorResponseSchema,
					429: ErrorResponseSchema,
					500: ErrorResponseSchema,
				},
				detail: {
					operationId: "deleteKey",
					summary: "Permanently delete a license key",
					security: [{ AdminKey: [] }],
				},
			},
		);
