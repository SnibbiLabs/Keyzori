import { describe, expect, mock, test } from "bun:test";
import type { Database } from "../db";
import type { ApiKey, RegisteredDevice, User } from "../domain/entities";
import { DrizzleDeviceRepository } from "../infrastructure/repositories/DrizzleDeviceRepository";
import { DrizzleKeyRepository } from "../infrastructure/repositories/DrizzleKeyRepository";
import { DrizzleUserRepository } from "../infrastructure/repositories/DrizzleUserRepository";

class FakeQuery {
	valuesInput: unknown;
	setInput: unknown;

	constructor(private readonly rows: unknown[]) {}

	from() {
		return this;
	}

	where() {
		return this;
	}

	limit() {
		return this;
	}

	orderBy() {
		return this;
	}

	innerJoin() {
		return this;
	}

	values(value: unknown) {
		this.valuesInput = value;
		return this;
	}

	set(value: unknown) {
		this.setInput = value;
		return this;
	}

	onConflictDoNothing() {
		return this;
	}

	async returning() {
		return this.rows;
	}

	// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are intentionally promise-like.
	then<TResult1 = unknown[], TResult2 = never>(
		onfulfilled?:
			| ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
			| null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	) {
		return Promise.resolve(this.rows).then(onfulfilled, onrejected);
	}
}

class FakeDatabase {
	readonly queries: FakeQuery[] = [];
	readonly select = mock(() => this.next(this.selectResults));
	readonly insert = mock(() => this.next(this.mutationResults));
	readonly update = mock(() => this.next(this.mutationResults));
	readonly delete = mock(() => this.next(this.mutationResults));

	constructor(
		private readonly selectResults: unknown[][] = [],
		private readonly mutationResults: unknown[][] = [],
	) {}

	private next(results: unknown[][]) {
		const query = new FakeQuery(results.shift() ?? []);
		this.queries.push(query);
		return query;
	}
}

const createdAt = new Date("2026-01-01T00:00:00.000Z");

const userFixture: User = {
	id: "user-1",
	email: "owner@example.com",
	name: "Owner",
	customFields: { company: "Example Co" },
	createdAt,
};

const storedKeyFixture = {
	id: "key-1",
	keyHash: "stored-hash",
	keyPrefix: "sk_123456789",
	userId: userFixture.id,
	type: "PERPETUAL" as const,
	limitIp: 1,
	limitHwid: 2,
	limitConcurrent: 3,
	limitUsage: 4,
	trialDurationMin: 5,
	firstActivatedAt: null,
	customFields: {},
	expiresAt: null,
	revoked: false,
	createdAt,
};

const apiKeyFixture: ApiKey = {
	id: storedKeyFixture.id,
	key: "sk_123456789...",
	userId: storedKeyFixture.userId,
	type: storedKeyFixture.type,
	limitIp: storedKeyFixture.limitIp,
	limitHwid: storedKeyFixture.limitHwid,
	limitConcurrent: storedKeyFixture.limitConcurrent,
	limitUsage: storedKeyFixture.limitUsage,
	trialDurationMin: storedKeyFixture.trialDurationMin,
	firstActivatedAt: storedKeyFixture.firstActivatedAt,
	customFields: storedKeyFixture.customFields,
	expiresAt: storedKeyFixture.expiresAt,
	revoked: storedKeyFixture.revoked,
	createdAt: storedKeyFixture.createdAt,
};

const deviceFixture: RegisteredDevice = {
	id: "device-1",
	ip: "203.0.113.10",
	hwid: "hwid-1",
	createdAt,
};

function asDatabase(database: FakeDatabase): Database {
	return database as unknown as Database;
}

describe("DrizzleKeyRepository", () => {
	test("creates keys with a hash while revealing the original secret once", async () => {
		const database = new FakeDatabase([], [[storedKeyFixture]]);
		const repository = new DrizzleKeyRepository(asDatabase(database));
		const secret = "sk_123456789abcdef";

		const result = await repository.create({
			key: secret,
			userId: userFixture.id,
			type: "PERPETUAL",
			limitIp: 1,
			limitHwid: 2,
			limitConcurrent: 3,
			limitUsage: 4,
			trialDurationMin: 5,
			firstActivatedAt: null,
			customFields: {},
			expiresAt: null,
		});

		expect(result.key).toBe(secret);
		expect(database.queries[0]?.valuesInput).toMatchObject({
			keyHash: new Bun.CryptoHasher("sha256").update(secret).digest("hex"),
			keyPrefix: secret.slice(0, 12),
		});
		expect(database.queries[0]?.valuesInput).not.toHaveProperty("key");
	});

	test("fails when a key mutation returns no row", async () => {
		const createRepository = new DrizzleKeyRepository(
			asDatabase(new FakeDatabase([], [[]])),
		);
		expect(
			createRepository.create({
				key: "sk_missing",
				userId: userFixture.id,
				type: "PERPETUAL",
				limitIp: 0,
				limitHwid: 0,
				limitConcurrent: 0,
				limitUsage: 0,
				trialDurationMin: 0,
				firstActivatedAt: null,
				customFields: {},
				expiresAt: null,
			}),
		).rejects.toThrow("Database returned no row after creating an API key");

		const updateRepository = new DrizzleKeyRepository(
			asDatabase(new FakeDatabase([], [[]])),
		);
		expect(
			updateRepository.update("missing", { revoked: true }),
		).rejects.toThrow("Database returned no row after updating an API key");
	});

	test("finds, lists, updates, and deletes keys with masked secrets", async () => {
		const database = new FakeDatabase(
			[[storedKeyFixture], [], [storedKeyFixture]],
			[[{ ...storedKeyFixture, revoked: true }], []],
		);
		const repository = new DrizzleKeyRepository(asDatabase(database));

		expect(await repository.findById("key-1")).toEqual(apiKeyFixture);
		expect(await repository.findById("missing")).toBeNull();
		expect(await repository.findAll()).toEqual([apiKeyFixture]);
		expect(await repository.update("key-1", { revoked: true })).toMatchObject({
			key: "sk_123456789...",
			revoked: true,
		});
		await expect(repository.delete("key-1")).resolves.toBeUndefined();
		expect(database.delete).toHaveBeenCalledTimes(1);
	});

	test("looks up hashed keys and attaches both whitelist collections", async () => {
		const ipWhitelist = {
			id: "ip-1",
			apiKeyId: "key-1",
			ip: "203.0.113.10",
			createdAt,
		};
		const hwidWhitelist = {
			id: "hwid-1",
			apiKeyId: "key-1",
			hwid: "device-hash",
			createdAt,
		};
		const database = new FakeDatabase([
			[storedKeyFixture],
			[ipWhitelist],
			[hwidWhitelist],
		]);
		const repository = new DrizzleKeyRepository(asDatabase(database));

		expect(await repository.findByKeyWithWhitelists("secret-key")).toEqual({
			...apiKeyFixture,
			whitelistedIps: [ipWhitelist],
			whitelistedHwids: [hwidWhitelist],
		});
		expect(database.select).toHaveBeenCalledTimes(3);
	});

	test("returns null without querying whitelists when a hash is unknown", async () => {
		const database = new FakeDatabase([[]]);
		const repository = new DrizzleKeyRepository(asDatabase(database));
		expect(await repository.findByKeyWithWhitelists("unknown")).toBeNull();
		expect(database.select).toHaveBeenCalledTimes(1);
	});
});

describe("DrizzleUserRepository", () => {
	test("creates and lists users", async () => {
		const database = new FakeDatabase([[userFixture]], [[userFixture]]);
		const repository = new DrizzleUserRepository(asDatabase(database));

		expect(
			await repository.create(
				userFixture.email,
				userFixture.name,
				userFixture.customFields,
			),
		).toEqual(userFixture);
		expect(database.queries[0]?.valuesInput).toMatchObject({
			email: userFixture.email,
			name: userFixture.name,
			customFields: userFixture.customFields,
		});
		expect(await repository.findAll()).toEqual([userFixture]);
	});

	test("fails when user creation returns no row", async () => {
		const repository = new DrizzleUserRepository(
			asDatabase(new FakeDatabase([], [[]])),
		);
		expect(repository.create("owner@example.com", "Owner", {})).rejects.toThrow(
			"Database returned no created user",
		);
	});

	test("translates duplicate email SQLSTATE failures into safe conflicts", async () => {
		const duplicate = {
			code: "23505",
			constraint: "User_email_key",
			detail: "sensitive database detail",
		};
		const query = {
			values() {
				return this;
			},
			set() {
				return this;
			},
			where() {
				return this;
			},
			async returning() {
				throw duplicate;
			},
		};
		const repository = new DrizzleUserRepository({
			insert: () => query,
			update: () => query,
		} as unknown as Database);
		for (const operation of [
			() => repository.create("duplicate@example.com", "Owner", {}),
			() => repository.update("user-1", { email: "duplicate@example.com" }),
		]) {
			try {
				await operation();
				throw new Error("Expected duplicate email conflict");
			} catch (error) {
				expect(error).toMatchObject({
					statusCode: 409,
					code: "CONFLICT",
					message: "A user with this email already exists",
				});
				expect(String(error)).not.toContain("sensitive database detail");
			}
		}
	});

	test("finds users by id and returns null when absent", async () => {
		const repository = new DrizzleUserRepository(
			asDatabase(new FakeDatabase([[userFixture], []])),
		);
		expect(await repository.findById("user-1")).toEqual(userFixture);
		expect(await repository.findById("missing")).toBeNull();
	});
});

describe("DrizzleDeviceRepository", () => {
	test("uses an advisory transaction lock when a runner is available", async () => {
		const execute = mock(async () => []);
		const transactionDatabase = { execute };
		const transaction = mock(
			async (operation: (database: unknown) => Promise<string>) =>
				await operation(transactionDatabase),
		);
		const repository = new DrizzleDeviceRepository({
			transaction,
		} as unknown as Database);
		const operation = mock(async () => "locked");

		expect(await repository.withKeyRegistrationLock("key-1", operation)).toBe(
			"locked",
		);
		expect(transaction).toHaveBeenCalledTimes(1);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(operation).toHaveBeenCalledTimes(1);
	});

	test("runs directly when already inside a transaction", async () => {
		const database = new FakeDatabase();
		const repository = new DrizzleDeviceRepository(asDatabase(database), null);
		const operation = mock(async () => "direct");
		expect(await repository.withKeyRegistrationLock("key-1", operation)).toBe(
			"direct",
		);
		expect(operation).toHaveBeenCalledWith(repository);
	});

	test("finds and creates devices, including conflict recovery", async () => {
		const foundRepository = new DrizzleDeviceRepository(
			asDatabase(new FakeDatabase([[deviceFixture], []])),
			null,
		);
		expect(
			await foundRepository.findDevice(deviceFixture.ip, deviceFixture.hwid),
		).toEqual(deviceFixture);
		expect(
			await foundRepository.findDevice("198.51.100.1", "missing"),
		).toBeNull();

		const createdDatabase = new FakeDatabase([], [[deviceFixture]]);
		const createdRepository = new DrizzleDeviceRepository(
			asDatabase(createdDatabase),
			null,
		);
		expect(
			await createdRepository.createDevice(
				deviceFixture.ip,
				deviceFixture.hwid,
			),
		).toEqual(deviceFixture);
		expect(createdDatabase.queries[0]?.valuesInput).toMatchObject({
			ip: deviceFixture.ip,
			hwid: deviceFixture.hwid,
		});

		const recoveredRepository = new DrizzleDeviceRepository(
			asDatabase(new FakeDatabase([[deviceFixture]], [[]])),
			null,
		);
		expect(
			await recoveredRepository.createDevice(
				deviceFixture.ip,
				deviceFixture.hwid,
			),
		).toEqual(deviceFixture);
	});

	test("fails when neither insertion nor conflict recovery finds a device", async () => {
		const repository = new DrizzleDeviceRepository(
			asDatabase(new FakeDatabase([[]], [[]])),
			null,
		);
		expect(repository.createDevice("203.0.113.10", "hwid")).rejects.toThrow(
			"Database returned no created device",
		);
	});

	test("reports key device usage and defaults missing counts to zero", async () => {
		const repository = new DrizzleDeviceRepository(
			asDatabase(
				new FakeDatabase([
					[{ uniqueIps: 2, uniqueHwids: 3 }],
					[{ id: "1" }],
					[],
				]),
			),
			null,
		);
		expect(
			await repository.getKeyDeviceUsage("key-1", "203.0.113.10", "hwid"),
		).toEqual({
			uniqueIps: 2,
			uniqueHwids: 3,
			ipRegistered: true,
			hwidRegistered: false,
		});

		const emptyRepository = new DrizzleDeviceRepository(
			asDatabase(new FakeDatabase([[], [], []])),
			null,
		);
		expect(
			await emptyRepository.getKeyDeviceUsage("key-1", "203.0.113.10", "hwid"),
		).toEqual({
			uniqueIps: 0,
			uniqueHwids: 0,
			ipRegistered: false,
			hwidRegistered: false,
		});
	});

	test("finds and creates mappings", async () => {
		const mapping = {
			id: "mapping-1",
			apiKeyId: "key-1",
			registeredDeviceId: "device-1",
			createdAt,
		};
		const repository = new DrizzleDeviceRepository(
			asDatabase(new FakeDatabase([[mapping], []], [[mapping]])),
			null,
		);
		expect(await repository.findMapping("key-1", "device-1")).toEqual(mapping);
		expect(await repository.findMapping("key-1", "missing")).toBeNull();
		expect(await repository.createMapping("key-1", "device-1")).toEqual(
			mapping,
		);
	});

	test("fails when mapping insertion returns no row", async () => {
		const repository = new DrizzleDeviceRepository(
			asDatabase(new FakeDatabase([], [[]])),
			null,
		);
		expect(repository.createMapping("key-1", "device-1")).rejects.toThrow(
			"Database returned no device mapping",
		);
	});

	test.each([
		[[{ id: "key-1" }], true],
		[[], false],
	] as const)("maps atomic usage updates to %p", async (rows, expected) => {
		const repository = new DrizzleDeviceRepository(
			asDatabase(new FakeDatabase([], [[...rows]])),
			null,
		);
		expect(await repository.consumeUsage("key-1")).toBe(expected);
	});
});
