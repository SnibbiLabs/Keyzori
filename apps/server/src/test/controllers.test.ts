import { describe, expect, mock, test } from "bun:test";
import Elysia, { type Context } from "elysia";
import type { AdminService } from "../application/services/AdminService";
import type { HandshakeService } from "../application/services/HandshakeService";
import { adminPlugin, createAdminAuthMiddleware } from "../controllers/admin";
import { handshakePlugin } from "../controllers/handshake";
import { ConflictError, NotFoundError } from "../domain/errors";

const createdAt = new Date("2026-01-01T00:00:00.000Z");
const user = {
	id: "user-1",
	email: "owner@example.com",
	name: "Owner",
	customFields: { company: "Example Co" },
	createdAt,
};
const key = {
	id: "key-1",
	key: "sk_example",
	userId: user.id,
	type: "PERPETUAL" as const,
	limitIp: 0,
	limitHwid: 0,
	limitConcurrent: 0,
	limitUsage: 0,
	trialDurationMin: 0,
	firstActivatedAt: null,
	customFields: {},
	expiresAt: null,
	revoked: false,
	createdAt,
};

function adminRequest(path: string, init?: RequestInit) {
	return new Request(`http://localhost${path}`, {
		...init,
		headers: {
			"content-type": "application/json",
			"x-admin-key": "admin-secret",
			...init?.headers,
		},
	});
}

describe("admin controller", () => {
	test("accepts any configured admin key using the default environment", () => {
		const previousPrimary = Bun.env.ADMIN_API_KEY;
		const previousAdditional = Bun.env.ADMIN_API_KEYS;
		try {
			Bun.env.ADMIN_API_KEY = "primary-secret";
			Bun.env.ADMIN_API_KEYS = " secondary-secret, tertiary-secret ";
			const middleware = createAdminAuthMiddleware();
			const set = {} as Context["set"];
			const result = middleware({
				request: new Request("http://localhost/admin/keys", {
					headers: { "x-admin-key": "secondary-secret" },
				}),
				set,
			} as Context);
			expect(result).toBeUndefined();
			expect(set.status).toBeUndefined();
		} finally {
			if (previousPrimary === undefined) delete Bun.env.ADMIN_API_KEY;
			else Bun.env.ADMIN_API_KEY = previousPrimary;
			if (previousAdditional === undefined) delete Bun.env.ADMIN_API_KEYS;
			else Bun.env.ADMIN_API_KEYS = previousAdditional;
		}
	});

	test("routes successful user and key operations", async () => {
		const service = {
			createUser: mock(async () => user),
			listUsers: mock(async () => [user]),
			getUser: mock(async () => user),
			updateUser: mock(async () => ({ ...user, name: "Updated owner" })),
			deleteUser: mock(async () => {}),
			createKey: mock(async () => key),
			listKeys: mock(async () => [key]),
			getKey: mock(async () => key),
			updateKey: mock(async () => ({ ...key, limitHwid: 2 })),
			deleteKey: mock(async () => {}),
			revokeKey: mock(async () => ({ ...key, revoked: true })),
		} as unknown as AdminService;
		const app = new Elysia().use(adminPlugin(service, ["admin-secret"]));

		const createUserResponse = await app.handle(
			adminRequest("/admin/users", {
				method: "POST",
				body: JSON.stringify({
					email: user.email,
					name: user.name,
					customFields: user.customFields,
				}),
			}),
		);
		expect(createUserResponse.status).toBe(201);
		expect(await createUserResponse.json()).toMatchObject({ id: user.id });
		expect(service.createUser).toHaveBeenCalledWith(
			user.email,
			user.name,
			user.customFields,
		);

		const listUsersResponse = await app.handle(adminRequest("/admin/users"));
		expect(listUsersResponse.status).toBe(200);
		expect(await listUsersResponse.json()).toHaveLength(1);

		const getUserResponse = await app.handle(
			adminRequest("/admin/users/user-1"),
		);
		expect(getUserResponse.status).toBe(200);

		const updateUserResponse = await app.handle(
			adminRequest("/admin/users/user-1", {
				method: "PATCH",
				body: JSON.stringify({
					name: "Updated owner",
					customFields: { accountId: "acct_123" },
				}),
			}),
		);
		expect(updateUserResponse.status).toBe(200);
		expect(service.updateUser).toHaveBeenCalledWith("user-1", {
			name: "Updated owner",
			customFields: { accountId: "acct_123" },
		});

		const createKeyResponse = await app.handle(
			adminRequest("/admin/keys", {
				method: "POST",
				body: JSON.stringify({ userId: user.id, type: "PERPETUAL" }),
			}),
		);
		expect(createKeyResponse.status).toBe(201);
		expect(await createKeyResponse.json()).toMatchObject({ id: key.id });

		const listKeysResponse = await app.handle(adminRequest("/admin/keys"));
		expect(listKeysResponse.status).toBe(200);
		expect(await listKeysResponse.json()).toHaveLength(1);

		const updateKeyResponse = await app.handle(
			adminRequest("/admin/keys/key-1", {
				method: "PUT",
				body: JSON.stringify({ limitHwid: 2 }),
			}),
		);
		expect(updateKeyResponse.status).toBe(200);

		const revokeResponse = await app.handle(
			adminRequest("/admin/keys/key-1", { method: "PATCH" }),
		);
		expect(revokeResponse.status).toBe(200);
		expect(await revokeResponse.json()).toMatchObject({ revoked: true });

		const deleteKeyResponse = await app.handle(
			adminRequest("/admin/keys/key-1", { method: "DELETE" }),
		);
		expect(deleteKeyResponse.status).toBe(200);
		expect(await deleteKeyResponse.json()).toEqual({ success: true });

		const deleteUserResponse = await app.handle(
			adminRequest("/admin/users/user-1", { method: "DELETE" }),
		);
		expect(deleteUserResponse.status).toBe(200);
	});

	test("maps domain and validation errors to safe responses", async () => {
		const service = {
			createUser: mock(async () => user),
			listUsers: mock(async () => [user]),
			createKey: mock(async () => key),
			listKeys: mock(async () => [key]),
			revokeKey: mock(async () => {
				throw new NotFoundError("ApiKey");
			}),
		} as unknown as AdminService;
		const app = new Elysia().use(adminPlugin(service, ["admin-secret"]));

		const missing = await app.handle(
			adminRequest("/admin/keys/missing", { method: "PATCH" }),
		);
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({
			error: "ApiKey not found",
			code: "NOT_FOUND",
		});

		const invalid = await app.handle(
			adminRequest("/admin/users", {
				method: "POST",
				body: JSON.stringify({ email: "not-an-email", name: "Owner" }),
			}),
		);
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toHaveProperty("error");
	});

	test("publishes duplicate owner emails as safe 409 conflicts", async () => {
		const service = {
			createUser: mock(async () => {
				throw new ConflictError("A user with this email already exists");
			}),
		} as unknown as AdminService;
		const app = new Elysia().use(adminPlugin(service, ["admin-secret"]));
		const response = await app.handle(
			adminRequest("/admin/users", {
				method: "POST",
				body: JSON.stringify({
					email: "duplicate@example.com",
					name: "Owner",
				}),
			}),
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "A user with this email already exists",
			code: "CONFLICT",
		});
	});
});

describe("handshake controller", () => {
	test("maps domain failures from handshake operations", async () => {
		const service = {
			processHandshake: mock(async () => {
				throw new NotFoundError("ApiKey");
			}),
			logout: mock(async () => ({ success: true as const })),
		} as unknown as HandshakeService;
		const app = new Elysia().use(handshakePlugin(service));
		const response = await app.handle(
			new Request("http://localhost/v1/handshake", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ apiKey: "sk_example", hwid: "hwid-1" }),
			}),
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: "ApiKey not found",
			code: "NOT_FOUND",
		});
	});
});
