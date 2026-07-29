import { describe, expect, test } from "bun:test";
import { AdminService } from "../application/services/AdminService";
import { NotFoundError } from "../domain/errors";
import type { ApiKey, User } from "../domain/entities";
import type { IKeyRepository } from "../domain/repositories/IKeyRepository";
import type { IUserRepository } from "../domain/repositories/IUserRepository";

const keyFixture: ApiKey = {
	id: "1",
	key: "sk_test",
	userId: "u1",
	type: "PERPETUAL",
	limitIp: 0,
	limitHwid: 0,
	limitConcurrent: 0,
	limitUsage: 0,
	trialDurationMin: 0,
	firstActivatedAt: null,
	customFields: {},
	expiresAt: null,
	revoked: false,
	createdAt: new Date(0),
};

const userFixture: User = {
	id: "u1",
	email: "owner@example.com",
	name: "Owner",
	customFields: {},
	createdAt: new Date(0),
};

const keyRepo: IKeyRepository = {
	create: async (data) => ({ ...keyFixture, ...data }),
	findById: async (id) => (id === "1" ? keyFixture : null),
	findAll: async () => [],
	update: async (id, data) => ({ ...keyFixture, id, ...data }),
	delete: async () => {},
	findByKeyWithWhitelists: async () => null,
};

const userRepo: IUserRepository = {
	create: async (email, name, customFields) => ({
		...userFixture,
		email,
		name,
		customFields,
	}),
	findById: async (id) => (id === userFixture.id ? userFixture : null),
	findAll: async () => [userFixture],
	update: async (id, data) => ({ ...userFixture, id, ...data }),
	delete: async () => {},
};

describe("AdminService", () => {
	const service = new AdminService(keyRepo, userRepo);

	test("creates a user", async () => {
		const user = await service.createUser(" NEW@EXAMPLE.COM ", " New Owner ", {
			company: "Example Co",
		});
		expect(user.email).toBe("new@example.com");
		expect(user.name).toBe("New Owner");
		expect(user.customFields).toEqual({ company: "Example Co" });
	});

	test("lists users and keys through repository boundaries", async () => {
		expect(await service.listUsers()).toEqual([userFixture]);
		expect(await service.listKeys()).toEqual([]);
	});

	test("gets and updates a user with normalized values", async () => {
		expect(await service.getUser("u1")).toEqual(userFixture);
		expect(
			await service.updateUser("u1", {
				email: " NEW@EXAMPLE.COM ",
				name: " New owner ",
				customFields: { accountId: "acct_123" },
			}),
		).toMatchObject({
			email: "new@example.com",
			name: "New owner",
			customFields: { accountId: "acct_123" },
		});
	});

	test("rejects empty user updates and missing users", async () => {
		expect(service.updateUser("u1", {})).rejects.toThrow(
			"At least one user field is required",
		);
		expect(service.getUser("missing")).rejects.toThrow("User not found");
		expect(service.deleteUser("missing")).rejects.toThrow("User not found");
	});

	test("rejects a blank normalized user name", async () => {
		expect(service.createUser("new@example.com", "   ")).rejects.toThrow(
			"User name is required",
		);
	});

	test("requires an existing user when creating a key", async () => {
		expect(
			service.createKey({ userId: "missing", type: "PERPETUAL" }),
		).rejects.toThrow("User not found");
	});

	test("rejects invalid numeric limits and expiry dates", async () => {
		expect(
			service.createKey({
				userId: "u1",
				type: "PERPETUAL",
				limitIp: 1.5,
			}),
		).rejects.toThrow("non-negative integers");
		expect(
			service.createKey({
				userId: "u1",
				type: "PERPETUAL",
				limitIp: 2_147_483_648,
			}),
		).rejects.toThrow("2147483647");
		expect(
			service.createKey({
				userId: "u1",
				type: "SUBSCRIPTION",
				expiresAt: "not-a-date",
			}),
		).rejects.toThrow("valid future date");
		expect(
			service.createKey({
				userId: "u1",
				type: "SUBSCRIPTION",
				expiresAt: "2000-01-01T00:00:00.000Z",
			}),
		).rejects.toThrow("valid future date");
	});

	test("requires a positive balance for USAGE keys", async () => {
		expect(
			service.createKey({ userId: "u1", type: "USAGE", limitUsage: 0 }),
		).rejects.toThrow("USAGE keys require limitUsage greater than zero");
	});

	test("requires an expiry for SUBSCRIPTION keys", async () => {
		expect(
			service.createKey({ userId: "u1", type: "SUBSCRIPTION" }),
		).rejects.toThrow("SUBSCRIPTION keys require expiresAt");
	});

	test("rejects ignored expiry values on other key types", async () => {
		expect(
			service.createKey({
				userId: "u1",
				type: "PERPETUAL",
				expiresAt: "2099-01-01T00:00:00.000Z",
			}),
		).rejects.toThrow("expiresAt is only valid for SUBSCRIPTION keys");
	});

	test("creates a valid key with normalized defaults", async () => {
		const key = await service.createKey({ userId: "u1", type: "PERPETUAL" });
		expect(key.key).toStartWith("sk_");
		expect(key.limitIp).toBe(0);
		expect(key.customFields).toEqual({});
	});

	test("revokeKey throws NotFoundError if key does not exist", async () => {
		expect(service.revokeKey("2")).rejects.toThrow(NotFoundError);
	});

	test("revokeKey sets revoked to true", async () => {
		const key = await service.revokeKey("1");
		expect(key.revoked).toBe(true);
	});

	test("updates mutable key fields and clears expiry by type", async () => {
		const updated = await service.updateKey("1", {
			type: "USAGE",
			limitUsage: 10,
			customFields: { tier: "metered" },
		});
		expect(updated).toMatchObject({
			type: "USAGE",
			limitUsage: 10,
			customFields: { tier: "metered" },
			expiresAt: null,
		});
	});

	test("validates key updates", async () => {
		expect(service.updateKey("1", {})).rejects.toThrow(
			"At least one license field is required",
		);
		expect(service.updateKey("1", { type: "SUBSCRIPTION" })).rejects.toThrow(
			"SUBSCRIPTION keys require expiresAt",
		);
		expect(
			service.updateKey("1", { type: "USAGE", limitUsage: 0 }),
		).rejects.toThrow("USAGE keys require limitUsage greater than zero");
	});

	test("gets and deletes keys through the repository boundary", async () => {
		expect(await service.getKey("1")).toEqual(keyFixture);
		expect(service.getKey("missing")).rejects.toThrow("ApiKey not found");
		await expect(service.deleteKey("1")).resolves.toBeUndefined();
	});
});
