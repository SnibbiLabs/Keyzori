import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";
import { LicenseClient } from "../apps/sdk/src/core/LicenseClient";
import { AdminService } from "../apps/server/src/application/services/AdminService";
import { HandshakeService } from "../apps/server/src/application/services/HandshakeService";
import { handshakePlugin } from "../apps/server/src/controllers/handshake";
import type {
	ApiKey,
	KeyDeviceMapping,
	NewApiKey,
	RegisteredDevice,
	User,
} from "../apps/server/src/domain/entities";
import type { JsonObject } from "../apps/server/src/domain/entities";
import type {
	ApiKeyUpdate,
	ApiKeyWithWhitelists,
	IKeyRepository,
} from "../apps/server/src/domain/repositories/IKeyRepository";
import type { IDeviceRepository } from "../apps/server/src/domain/repositories/IDeviceRepository";
import type {
	ISessionRepository,
	SessionBinding,
} from "../apps/server/src/domain/repositories/ISessionRepository";
import type {
	IUserRepository,
	UserUpdate,
} from "../apps/server/src/domain/repositories/IUserRepository";

class MemoryUserRepository implements IUserRepository {
	readonly users: User[] = [];

	async create(
		email: string,
		name: string,
		customFields: JsonObject,
	): Promise<User> {
		const user = {
			id: crypto.randomUUID(),
			email,
			name,
			customFields,
			createdAt: new Date(),
		};
		this.users.push(user);
		return user;
	}

	async findById(id: string): Promise<User | null> {
		return this.users.find((user) => user.id === id) ?? null;
	}

	async findAll(): Promise<User[]> {
		return [...this.users];
	}

	async update(id: string, data: UserUpdate): Promise<User> {
		const user = this.users.find((candidate) => candidate.id === id);
		if (!user) throw new Error("Missing user");
		Object.assign(user, data);
		return user;
	}

	async delete(id: string): Promise<void> {
		const index = this.users.findIndex((user) => user.id === id);
		if (index >= 0) this.users.splice(index, 1);
	}
}

class MemoryKeyRepository implements IKeyRepository {
	readonly keys: ApiKey[] = [];

	async create(data: NewApiKey): Promise<ApiKey> {
		const key = {
			...data,
			id: crypto.randomUUID(),
			revoked: false,
			createdAt: new Date(),
		};
		this.keys.push(key);
		return key;
	}

	async findById(id: string): Promise<ApiKey | null> {
		return this.keys.find((key) => key.id === id) ?? null;
	}

	async findAll(): Promise<ApiKey[]> {
		return [...this.keys];
	}

	async update(id: string, data: ApiKeyUpdate): Promise<ApiKey> {
		const key = this.keys.find((candidate) => candidate.id === id);
		if (!key) throw new Error("Missing key");
		Object.assign(key, data);
		return key;
	}

	async delete(id: string): Promise<void> {
		const index = this.keys.findIndex((key) => key.id === id);
		if (index >= 0) this.keys.splice(index, 1);
	}

	async findByKeyWithWhitelists(
		value: string,
	): Promise<ApiKeyWithWhitelists | null> {
		const key = this.keys.find((candidate) => candidate.key === value);
		return key ? { ...key, whitelistedIps: [], whitelistedHwids: [] } : null;
	}
}

class MemoryDeviceRepository implements IDeviceRepository {
	readonly devices: RegisteredDevice[] = [];
	readonly mappings: KeyDeviceMapping[] = [];

	constructor(private readonly keys: MemoryKeyRepository) {}

	async withKeyRegistrationLock<T>(
		_apiKeyId: string,
		operation: (repository: IDeviceRepository) => Promise<T>,
	): Promise<T> {
		return await operation(this);
	}

	async findDevice(ip: string, hwid: string): Promise<RegisteredDevice | null> {
		return (
			this.devices.find((device) => device.ip === ip && device.hwid === hwid) ??
			null
		);
	}

	async createDevice(ip: string, hwid: string): Promise<RegisteredDevice> {
		const device = { id: crypto.randomUUID(), ip, hwid, createdAt: new Date() };
		this.devices.push(device);
		return device;
	}

	async getKeyDeviceUsage(apiKeyId: string, ip: string, hwid: string) {
		const devices = this.mappings
			.filter((mapping) => mapping.apiKeyId === apiKeyId)
			.flatMap((mapping) =>
				this.devices.filter(
					(device) => device.id === mapping.registeredDeviceId,
				),
			);
		return {
			uniqueIps: new Set(devices.map((device) => device.ip)).size,
			uniqueHwids: new Set(devices.map((device) => device.hwid)).size,
			ipRegistered: devices.some((device) => device.ip === ip),
			hwidRegistered: devices.some((device) => device.hwid === hwid),
		};
	}

	async findMapping(
		apiKeyId: string,
		deviceId: string,
	): Promise<KeyDeviceMapping | null> {
		return (
			this.mappings.find(
				(mapping) =>
					mapping.apiKeyId === apiKeyId &&
					mapping.registeredDeviceId === deviceId,
			) ?? null
		);
	}

	async createMapping(
		apiKeyId: string,
		deviceId: string,
	): Promise<KeyDeviceMapping> {
		const mapping = {
			id: crypto.randomUUID(),
			apiKeyId,
			registeredDeviceId: deviceId,
			createdAt: new Date(),
		};
		this.mappings.push(mapping);
		return mapping;
	}

	async consumeUsage(apiKeyId: string): Promise<boolean> {
		const key = this.keys.keys.find((candidate) => candidate.id === apiKeyId);
		if (!key) throw new Error("Missing key");
		if (key.limitUsage <= 0) return false;
		key.limitUsage--;
		return true;
	}
}

class MemorySessionRepository implements ISessionRepository {
	readonly sessions = new Map<string, Map<string, string>>();

	async registerSession(
		apiKeyId: string,
		binding: SessionBinding,
		_ttlSeconds: number,
		maxConcurrent: number,
	): Promise<
		{ status: "registered"; token: string } | { status: "limit-reached" }
	> {
		const sessions = this.sessions.get(apiKeyId) ?? new Map<string, string>();
		if (maxConcurrent > 0 && sessions.size >= maxConcurrent) {
			return { status: "limit-reached" };
		}
		const token = crypto.randomUUID();
		sessions.set(token, `${binding.ip}\0${binding.hwid}`);
		this.sessions.set(apiKeyId, sessions);
		return { status: "registered", token };
	}

	async refreshSession(
		apiKeyId: string,
		sessionToken: string,
		binding: SessionBinding,
		_ttlSeconds: number,
	): Promise<boolean> {
		return (
			this.sessions.get(apiKeyId)?.get(sessionToken) ===
			`${binding.ip}\0${binding.hwid}`
		);
	}

	async getActiveSessionCount(apiKeyId: string): Promise<number> {
		return this.sessions.get(apiKeyId)?.size ?? 0;
	}

	async removeSession(
		apiKeyId: string,
		sessionToken: string,
		binding: SessionBinding,
	): Promise<boolean> {
		const sessions = this.sessions.get(apiKeyId);
		if (sessions?.get(sessionToken) !== `${binding.ip}\0${binding.hwid}`) {
			return false;
		}
		return sessions.delete(sessionToken);
	}
}

describe("admin delivery -> server -> SDK product flow", () => {
	let originalFetch: typeof fetch;
	let originalConsoleError: typeof console.error;

	beforeEach(() => {
		originalFetch = global.fetch;
		originalConsoleError = console.error;
		console.error = mock(() => {}) as unknown as typeof console.error;
	});

	afterEach(() => {
		global.fetch = originalFetch;
		console.error = originalConsoleError;
	});

	test("creates, validates, logs out, revokes, and rejects a license", async () => {
		const users = new MemoryUserRepository();
		const keys = new MemoryKeyRepository();
		const devices = new MemoryDeviceRepository(keys);
		const sessions = new MemorySessionRepository();
		const admin = new AdminService(keys, users);
		const app = new Elysia().use(
			handshakePlugin(new HandshakeService(keys, devices, sessions)),
		);

		global.fetch = (async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			const request =
				input instanceof Request
					? input
					: new Request(input.toString(), init as RequestInit | undefined);
			return await app.handle(request);
		}) as unknown as typeof fetch;

		const user = await admin.createUser("Owner@Example.com", "Owner");
		const key = await admin.createKey({
			userId: user.id,
			type: "PERPETUAL",
			limitHwid: 1,
			limitConcurrent: 1,
			customFields: { tier: "premium" },
		});

		const sdk = new LicenseClient({
			apiKey: key.key,
			serverUrl: "https://keyzori.test",
		});
		expect(await sdk.initialize()).toEqual({ tier: "premium" });
		expect(await sessions.getActiveSessionCount(key.id)).toBe(1);
		await sdk.destroy();
		expect(await sessions.getActiveSessionCount(key.id)).toBe(0);

		await admin.revokeKey(key.id);
		const rejectedSdk = new LicenseClient({
			apiKey: key.key,
			serverUrl: "https://keyzori.test",
		});
		expect(rejectedSdk.initialize()).rejects.toThrow(
			"Invalid or revoked API key",
		);
	});
});
