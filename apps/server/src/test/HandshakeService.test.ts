import { describe, expect, mock, test } from "bun:test";
import { HandshakeService } from "../application/services/HandshakeService";
import type {
	ApiKey,
	KeyDeviceMapping,
	RegisteredDevice,
} from "../domain/entities";
import { DomainError } from "../domain/errors";
import type { IDeviceRepository } from "../domain/repositories/IDeviceRepository";
import type {
	ApiKeyWithWhitelists,
	IKeyRepository,
} from "../domain/repositories/IKeyRepository";
import type {
	ISessionRepository,
	SessionBinding,
	SessionRegistrationResult,
} from "../domain/repositories/ISessionRepository";

const keyFixture: ApiKeyWithWhitelists = {
	id: "key-1",
	key: "valid-key",
	userId: "user-1",
	type: "PERPETUAL",
	limitIp: 0,
	limitHwid: 0,
	limitConcurrent: 0,
	limitUsage: 0,
	trialDurationMin: 0,
	firstActivatedAt: null,
	customFields: { tier: "premium" },
	expiresAt: null,
	revoked: false,
	createdAt: new Date(0),
	whitelistedIps: [],
	whitelistedHwids: [],
};

function createHarness(overrides: Partial<ApiKeyWithWhitelists> = {}) {
	const key = { ...keyFixture, ...overrides };
	const consumeUsage = mock(async (): Promise<boolean> => true);
	const update = mock(
		async (_id: string, data: Partial<ApiKey>): Promise<ApiKey> => ({
			...key,
			...data,
		}),
	);
	const keyRepo: IKeyRepository = {
		create: async () => key,
		findById: async () => key,
		findAll: async () => [key],
		update,
		delete: async () => {},
		findByKeyWithWhitelists: async (value) => (value === key.key ? key : null),
	};

	const device: RegisteredDevice = {
		id: "device-1",
		ip: "203.0.113.10",
		hwid: "hwid-1",
		createdAt: new Date(0),
	};
	const mapping: KeyDeviceMapping = {
		id: "mapping-1",
		apiKeyId: key.id,
		registeredDeviceId: device.id,
		createdAt: new Date(0),
	};
	const findMapping = mock(
		async (): Promise<KeyDeviceMapping | null> => mapping,
	);
	const getKeyDeviceUsage = mock(async () => ({
		uniqueIps: 0,
		uniqueHwids: 0,
		ipRegistered: false,
		hwidRegistered: false,
	}));
	const createMapping = mock(async (): Promise<KeyDeviceMapping> => mapping);
	const deviceRepo: IDeviceRepository = {
		withKeyRegistrationLock: async (_apiKeyId, operation) =>
			await operation(deviceRepo),
		findDevice: async () => device,
		createDevice: async () => device,
		getKeyDeviceUsage,
		findMapping,
		createMapping,
		consumeUsage,
	};

	const registerSession = mock(
		async (): Promise<SessionRegistrationResult> => ({
			status: "registered",
			token: "11111111-1111-4111-8111-111111111111",
		}),
	);
	const refreshSession = mock(
		async (
			_apiKeyId: string,
			_sessionToken: string,
			_binding: SessionBinding,
			_ttlSeconds: number,
		): Promise<boolean> => true,
	);
	const removeSession = mock(async (): Promise<boolean> => true);
	const sessionRepo: ISessionRepository = {
		registerSession,
		refreshSession,
		removeSession,
	};

	return {
		service: new HandshakeService(keyRepo, deviceRepo, sessionRepo),
		key,
		consumeUsage,
		update,
		findMapping,
		getKeyDeviceUsage,
		createMapping,
		registerSession,
		refreshSession,
		removeSession,
	};
}

describe("HandshakeService", () => {
	test("rejects an invalid key", async () => {
		const { service } = createHarness();
		expect(
			service.processHandshake("bad-key", "hwid-1", "session-1", "ip"),
		).rejects.toThrow(DomainError);
	});

	test("rejects an IP outside the explicit whitelist", async () => {
		const { service } = createHarness({
			whitelistedIps: [
				{
					id: "ip-1",
					apiKeyId: "key-1",
					ip: "10.0.0.1",
					createdAt: new Date(0),
				},
			],
		});
		expect(
			service.processHandshake(
				"valid-key",
				"hwid-1",
				undefined,
				"203.0.113.10",
			),
		).rejects.toThrow("IP address not whitelisted");
	});

	test("rejects hardware, trial, and subscription violations", async () => {
		const hardware = createHarness({
			whitelistedHwids: [
				{
					id: "hwid-allowed",
					apiKeyId: "key-1",
					hwid: "other-hwid",
					createdAt: new Date(0),
				},
			],
		});
		expect(
			hardware.service.processHandshake(
				"valid-key",
				"hwid-1",
				undefined,
				"203.0.113.10",
			),
		).rejects.toThrow("HWID not whitelisted");

		const trial = createHarness({
			trialDurationMin: 1,
			firstActivatedAt: new Date(0),
		});
		expect(
			trial.service.processHandshake(
				"valid-key",
				"hwid-1",
				undefined,
				"203.0.113.10",
			),
		).rejects.toThrow("Trial has expired");

		const subscription = createHarness({
			type: "SUBSCRIPTION",
			expiresAt: new Date(0),
		});
		expect(
			subscription.service.processHandshake(
				"valid-key",
				"hwid-1",
				undefined,
				"203.0.113.10",
			),
		).rejects.toThrow("Subscription expired");
	});

	test("rejects an invalid server-issued session token", async () => {
		const harness = createHarness();
		harness.refreshSession.mockResolvedValueOnce(false);
		expect(
			harness.service.processHandshake(
				"valid-key",
				"hwid-1",
				"11111111-1111-4111-8111-111111111111",
				"203.0.113.10",
			),
		).rejects.toThrow("Invalid or expired session token");
	});

	test("enforces distinct IP registrations", async () => {
		const harness = createHarness({ limitIp: 1 });
		harness.findMapping.mockResolvedValueOnce(null);
		harness.getKeyDeviceUsage.mockResolvedValueOnce({
			uniqueIps: 1,
			uniqueHwids: 1,
			ipRegistered: false,
			hwidRegistered: true,
		});
		expect(
			harness.service.processHandshake(
				"valid-key",
				"hwid-1",
				undefined,
				"203.0.113.10",
			),
		).rejects.toThrow("IP registration threshold exceeded");
		expect(harness.createMapping).not.toHaveBeenCalled();
	});

	test("enforces distinct hardware registrations", async () => {
		const harness = createHarness({ limitHwid: 1 });
		harness.findMapping.mockResolvedValueOnce(null);
		harness.getKeyDeviceUsage.mockResolvedValueOnce({
			uniqueIps: 1,
			uniqueHwids: 1,
			ipRegistered: true,
			hwidRegistered: false,
		});
		expect(
			harness.service.processHandshake(
				"valid-key",
				"hwid-1",
				undefined,
				"203.0.113.10",
			),
		).rejects.toThrow("Hardware registration threshold exceeded");
	});

	test("rejects a new session when concurrency is full", async () => {
		const harness = createHarness({ limitConcurrent: 1 });
		harness.registerSession.mockResolvedValueOnce({ status: "limit-reached" });
		expect(
			harness.service.processHandshake(
				"valid-key",
				"hwid-1",
				undefined,
				"203.0.113.10",
			),
		).rejects.toThrow("Maximum concurrent sessions reached");
		expect(harness.consumeUsage).not.toHaveBeenCalled();
	});

	test("charges a USAGE key only for a new session, not its heartbeat", async () => {
		const harness = createHarness({ type: "USAGE", limitUsage: 2 });
		await harness.service.processHandshake(
			"valid-key",
			"hwid-1",
			undefined,
			"203.0.113.10",
		);
		await harness.service.processHandshake(
			"valid-key",
			"hwid-1",
			"11111111-1111-4111-8111-111111111111",
			"203.0.113.10",
		);
		expect(harness.consumeUsage).toHaveBeenCalledTimes(1);
		expect(harness.registerSession).toHaveBeenCalledTimes(1);
		expect(harness.refreshSession).toHaveBeenCalledTimes(1);
		expect(harness.refreshSession).toHaveBeenCalledWith(
			"key-1",
			"11111111-1111-4111-8111-111111111111",
			{ ip: "203.0.113.10", hwid: "hwid-1" },
			45,
		);
	});

	test("rejects a session token replayed from another client context", async () => {
		const harness = createHarness({ type: "USAGE", limitUsage: 2 });
		harness.refreshSession.mockImplementationOnce(
			async (_keyId, _token, binding): Promise<boolean> =>
				binding.ip === "203.0.113.10" && binding.hwid === "hwid-1",
		);
		expect(
			harness.service.processHandshake(
				"valid-key",
				"different-hwid",
				"11111111-1111-4111-8111-111111111111",
				"198.51.100.20",
			),
		).rejects.toThrow("Invalid or expired session token");
		expect(harness.consumeUsage).not.toHaveBeenCalled();
	});

	test("rejects an exhausted USAGE key before registering a session", async () => {
		const harness = createHarness({ type: "USAGE", limitUsage: 0 });
		expect(
			harness.service.processHandshake(
				"valid-key",
				"hwid-1",
				undefined,
				"203.0.113.10",
			),
		).rejects.toThrow("Usage balance exhausted");
		expect(harness.consumeUsage).not.toHaveBeenCalled();
		expect(harness.removeSession).toHaveBeenCalledTimes(1);
	});

	test("rejects when another session atomically consumes the last usage", async () => {
		const harness = createHarness({ type: "USAGE", limitUsage: 1 });
		harness.consumeUsage.mockResolvedValueOnce(false);
		expect(
			harness.service.processHandshake(
				"valid-key",
				"hwid-1",
				undefined,
				"203.0.113.10",
			),
		).rejects.toThrow("Usage balance exhausted");
		expect(harness.removeSession).toHaveBeenCalledTimes(1);
	});

	test("activates a trial on its first successful handshake", async () => {
		const harness = createHarness({ trialDurationMin: 60 });
		const result = await harness.service.processHandshake(
			"valid-key",
			"hwid-1",
			undefined,
			"203.0.113.10",
		);
		expect(result).toEqual({
			success: true,
			type: "PERPETUAL",
			customFields: { tier: "premium" },
			sessionToken: "11111111-1111-4111-8111-111111111111",
			sessionTtlSeconds: 45,
		});
		expect(harness.update).toHaveBeenCalledTimes(1);
	});

	test("logout removes only a resolved key session", async () => {
		const harness = createHarness();
		expect(
			await harness.service.logout(
				"valid-key",
				"11111111-1111-4111-8111-111111111111",
				"hwid-1",
				"203.0.113.10",
			),
		).toEqual({ success: true });
		expect(harness.removeSession).toHaveBeenCalledTimes(1);
		expect(
			await harness.service.logout(
				"missing-key",
				"22222222-2222-4222-8222-222222222222",
				"hwid-1",
				"203.0.113.10",
			),
		).toEqual({ success: true });
		expect(harness.removeSession).toHaveBeenCalledTimes(1);
	});
});
