import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { LicenseClient } from "../apps/sdk/src/core/LicenseClient";
import { LicenseRequestError } from "../apps/sdk/src/core/LicenseRequestError";
import { AdminService } from "../apps/server/src/application/services/AdminService";
import { LicenseService } from "../apps/server/src/application/services/LicenseService";
import { licensePlugin } from "../apps/server/src/controllers/license";
import type {
	Customer,
	DeviceAllowlistEntry,
	IpAllowlistEntry,
	JsonObject,
	License,
	LicenseMeter,
	NewLicense,
	RegisteredDevice,
	RevealedLicense,
	UsageLedgerEntry,
} from "../apps/server/src/domain/entities";
import type {
	AccessRecords,
	IAccessRepository,
} from "../apps/server/src/domain/repositories/IAccessRepository";
import type {
	CustomerUpdate,
	ICustomerRepository,
} from "../apps/server/src/domain/repositories/ICustomerRepository";
import type {
	IDeviceRepository,
	LicenseDeviceUsage,
} from "../apps/server/src/domain/repositories/IDeviceRepository";
import type {
	ILicenseRepository,
	LicenseUpdate,
	LicenseUpdateOptions,
	LicenseWithAllowlists,
} from "../apps/server/src/domain/repositories/ILicenseRepository";
import type {
	IMeterRepository,
	MeterAdjustmentResult,
	UsageConsumptionResult,
} from "../apps/server/src/domain/repositories/IMeterRepository";
import type {
	ISessionRepository,
	ResolvedSession,
	SessionBinding,
	SessionRegistrationResult,
} from "../apps/server/src/domain/repositories/ISessionRepository";

class MemoryCustomerRepository implements ICustomerRepository {
	readonly records = new Map<string, Customer>();

	async create(
		email: string,
		name: string,
		metadata: JsonObject,
	): Promise<Customer> {
		const now = new Date();
		const customer = {
			id: crypto.randomUUID(),
			email,
			name,
			metadata,
			createdAt: now,
			updatedAt: now,
		};
		this.records.set(customer.id, customer);
		return structuredClone(customer);
	}

	async findById(id: string): Promise<Customer | null> {
		return structuredClone(this.records.get(id) ?? null);
	}

	async findAll(): Promise<Customer[]> {
		return structuredClone([...this.records.values()]);
	}

	async update(id: string, data: CustomerUpdate): Promise<Customer> {
		const current = this.records.get(id);
		if (!current) throw new Error("Customer not found");
		const updated = { ...current, ...data, updatedAt: new Date() };
		this.records.set(id, updated);
		return structuredClone(updated);
	}

	async delete(id: string): Promise<void> {
		this.records.delete(id);
	}
}

class MemoryAccessRepository implements IAccessRepository {
	readonly allowedIps = new Map<string, IpAllowlistEntry[]>();
	readonly allowedDevices = new Map<string, DeviceAllowlistEntry[]>();

	constructor(private readonly devices: () => RegisteredDevice[]) {}

	async getAccessRecords(licenseId: string): Promise<AccessRecords> {
		return structuredClone({
			allowedIps: this.allowedIps.get(licenseId) ?? [],
			allowedDevices: this.allowedDevices.get(licenseId) ?? [],
			registeredDevices: this.devices().filter(
				(device) => device.licenseId === licenseId,
			),
			attemptedIps: [],
			attemptedDevices: [],
		});
	}

	async addAllowedIp(licenseId: string, ip: string): Promise<IpAllowlistEntry> {
		const entries = this.allowedIps.get(licenseId) ?? [];
		const existing = entries.find((entry) => entry.ip === ip);
		if (existing) return structuredClone(existing);
		const entry = {
			id: crypto.randomUUID(),
			licenseId,
			ip,
			createdAt: new Date(),
		};
		entries.push(entry);
		this.allowedIps.set(licenseId, entries);
		return structuredClone(entry);
	}

	async removeAllowedIp(licenseId: string, ip: string): Promise<boolean> {
		const entries = this.allowedIps.get(licenseId) ?? [];
		const index = entries.findIndex((entry) => entry.ip === ip);
		if (index < 0) return false;
		entries.splice(index, 1);
		return true;
	}

	async addAllowedDevice(
		licenseId: string,
		deviceId: string,
	): Promise<DeviceAllowlistEntry> {
		const entries = this.allowedDevices.get(licenseId) ?? [];
		const existing = entries.find((entry) => entry.deviceId === deviceId);
		if (existing) return structuredClone(existing);
		const entry = {
			id: crypto.randomUUID(),
			licenseId,
			deviceId,
			createdAt: new Date(),
		};
		entries.push(entry);
		this.allowedDevices.set(licenseId, entries);
		return structuredClone(entry);
	}

	async removeAllowedDevice(
		licenseId: string,
		deviceId: string,
	): Promise<boolean> {
		const entries = this.allowedDevices.get(licenseId) ?? [];
		const index = entries.findIndex((entry) => entry.deviceId === deviceId);
		if (index < 0) return false;
		entries.splice(index, 1);
		return true;
	}
}

class MemoryMeterRepository implements IMeterRepository {
	readonly meters: LicenseMeter[] = [];
	readonly ledger: UsageLedgerEntry[] = [];

	addInitial(licenseId: string, inputs: NewLicense["meters"]): void {
		for (const input of inputs) {
			const now = new Date();
			this.meters.push({
				id: crypto.randomUUID(),
				licenseId,
				name: input.name,
				balance: input.balance,
				archivedAt: null,
				createdAt: now,
				updatedAt: now,
			});
		}
	}

	async listMeters(
		licenseId: string,
		includeArchived = false,
	): Promise<LicenseMeter[]> {
		return structuredClone(
			this.meters.filter(
				(meter) =>
					meter.licenseId === licenseId &&
					(includeArchived || meter.archivedAt === null),
			),
		);
	}

	async createMeter(
		licenseId: string,
		name: string,
		balance: number,
		_reason: string,
	): Promise<LicenseMeter> {
		if (
			this.meters.some(
				(meter) => meter.licenseId === licenseId && meter.name === name,
			)
		) {
			throw new Error("Duplicate meter");
		}
		this.addInitial(licenseId, [{ name, balance, reason: "created" }]);
		return structuredClone(this.meters.at(-1) as LicenseMeter);
	}

	async archiveMeter(
		licenseId: string,
		name: string,
		_reason: string,
	): Promise<LicenseMeter | null> {
		const meter = this.findMeter(licenseId, name);
		if (!meter) return null;
		meter.archivedAt ??= new Date();
		meter.updatedAt = new Date();
		return structuredClone(meter);
	}

	async consume(
		licenseId: string,
		meterName: string,
		units: number,
		eventId: string,
	): Promise<UsageConsumptionResult> {
		const existing = this.ledger.find(
			(entry) => entry.licenseId === licenseId && entry.eventId === eventId,
		);
		if (existing) {
			const existingMeter = this.meters.find(
				(meter) => meter.id === existing.meterId,
			);
			if (
				!existingMeter ||
				existing.kind !== "consume" ||
				existing.delta !== -units ||
				existingMeter.name !== meterName
			) {
				return { status: "conflict" };
			}
			return {
				status: "replayed",
				meter: { ...existingMeter, balance: existing.balanceAfter },
				entry: structuredClone(existing),
			};
		}

		const meter = this.findMeter(licenseId, meterName);
		if (!meter) return { status: "not-found" };
		if (meter.archivedAt) return { status: "archived" };
		if (meter.balance < units) return { status: "exhausted" };
		const balanceBefore = meter.balance;
		meter.balance -= units;
		meter.updatedAt = new Date();
		const entry: UsageLedgerEntry = {
			id: crypto.randomUUID(),
			licenseId,
			meterId: meter.id,
			eventId,
			kind: "consume",
			delta: -units,
			balanceBefore,
			balanceAfter: meter.balance,
			reason: null,
			createdAt: new Date(),
		};
		this.ledger.push(entry);
		return {
			status: "consumed",
			meter: structuredClone(meter),
			entry: structuredClone(entry),
		};
	}

	async adjust(
		licenseId: string,
		meterName: string,
		delta: number,
		reason: string,
		kind: "top_up" | "adjustment",
	): Promise<MeterAdjustmentResult> {
		const meter = this.findMeter(licenseId, meterName);
		if (!meter) return { status: "not-found" };
		if (meter.archivedAt) return { status: "archived" };
		if (meter.balance + delta < 0) return { status: "out-of-range" };
		const balanceBefore = meter.balance;
		meter.balance += delta;
		meter.updatedAt = new Date();
		const entry: UsageLedgerEntry = {
			id: crypto.randomUUID(),
			licenseId,
			meterId: meter.id,
			eventId: `operator:${crypto.randomUUID()}`,
			kind,
			delta,
			balanceBefore,
			balanceAfter: meter.balance,
			reason,
			createdAt: new Date(),
		};
		this.ledger.push(entry);
		return {
			status: "adjusted",
			meter: structuredClone(meter),
			entry: structuredClone(entry),
		};
	}

	async listLedger(
		licenseId: string,
		meterName?: string,
	): Promise<UsageLedgerEntry[]> {
		return structuredClone(
			this.ledger.filter((entry) => {
				if (entry.licenseId !== licenseId) return false;
				if (!meterName) return true;
				return (
					this.meters.find((meter) => meter.id === entry.meterId)?.name ===
					meterName
				);
			}),
		);
	}

	private findMeter(licenseId: string, name: string): LicenseMeter | undefined {
		return this.meters.find(
			(meter) => meter.licenseId === licenseId && meter.name === name,
		);
	}
}

class MemoryLicenseRepository implements ILicenseRepository {
	readonly records = new Map<string, License>();
	readonly secrets = new Map<string, string>();

	constructor(
		private readonly access: MemoryAccessRepository,
		private readonly meters: MemoryMeterRepository,
	) {}

	async create(data: NewLicense): Promise<RevealedLicense> {
		const now = new Date();
		const license: License = {
			id: crypto.randomUUID(),
			keyPrefix: data.licenseKey.slice(0, 16),
			customerId: data.customerId,
			type: data.type,
			maxIps: data.maxIps,
			maxDevices: data.maxDevices,
			maxSessions: data.maxSessions,
			trialDurationMinutes: data.trialDurationMinutes,
			trialStartedAt: data.trialStartedAt,
			metadata: structuredClone(data.metadata),
			expiresAt: data.expiresAt,
			typeDrafts: structuredClone(data.typeDrafts),
			manualRevokedAt: null,
			manualRevocationReason: null,
			billingRevokedAt: null,
			sessionRevision: 0,
			createdAt: now,
			updatedAt: now,
		};
		this.records.set(license.id, license);
		this.secrets.set(data.licenseKey, license.id);
		this.meters.addInitial(license.id, data.meters);
		return { ...structuredClone(license), licenseKey: data.licenseKey };
	}

	async findById(id: string): Promise<License | null> {
		return structuredClone(this.records.get(id) ?? null);
	}

	async findByIdWithAllowlists(
		id: string,
	): Promise<LicenseWithAllowlists | null> {
		const license = this.records.get(id);
		return license ? this.withAllowlists(license) : null;
	}

	async findAll(): Promise<License[]> {
		return structuredClone([...this.records.values()]);
	}

	async update(
		id: string,
		data: LicenseUpdate,
		options: LicenseUpdateOptions = {},
	): Promise<License> {
		const current = this.records.get(id);
		if (!current) throw new Error("License not found");
		if (options.newMeters?.length) {
			this.meters.addInitial(id, options.newMeters);
		}
		const updated = {
			...current,
			...structuredClone(data),
			updatedAt: new Date(),
		};
		this.records.set(id, updated);
		return structuredClone(updated);
	}

	async delete(id: string): Promise<void> {
		this.records.delete(id);
		for (const [secret, licenseId] of this.secrets) {
			if (licenseId === id) this.secrets.delete(secret);
		}
	}

	async findByLicenseKeyWithAllowlists(
		licenseKey: string,
	): Promise<LicenseWithAllowlists | null> {
		const id = this.secrets.get(licenseKey);
		if (!id) return null;
		const license = this.records.get(id);
		return license ? this.withAllowlists(license) : null;
	}

	async rotateKey(id: string, licenseKey: string): Promise<RevealedLicense> {
		const current = this.records.get(id);
		if (!current) throw new Error("License not found");
		for (const [secret, licenseId] of this.secrets) {
			if (licenseId === id) this.secrets.delete(secret);
		}
		const updated = {
			...current,
			keyPrefix: licenseKey.slice(0, 16),
			sessionRevision: current.sessionRevision + 1,
			updatedAt: new Date(),
		};
		this.records.set(id, updated);
		this.secrets.set(licenseKey, id);
		return { ...structuredClone(updated), licenseKey };
	}

	async incrementSessionRevision(id: string): Promise<License> {
		const current = this.records.get(id);
		if (!current) throw new Error("License not found");
		current.sessionRevision++;
		current.updatedAt = new Date();
		return structuredClone(current);
	}

	async updateWithSessionInvalidation(
		id: string,
		data: LicenseUpdate,
	): Promise<License> {
		const current = this.records.get(id);
		if (!current) throw new Error("License not found");
		const updated = {
			...current,
			...structuredClone(data),
			sessionRevision: current.sessionRevision + 1,
			updatedAt: new Date(),
		};
		this.records.set(id, updated);
		return structuredClone(updated);
	}

	async updateMeterDraft(id: string, meterNames: string[]): Promise<License> {
		const current = this.records.get(id);
		if (!current) throw new Error("License not found");
		current.typeDrafts = {
			...current.typeDrafts,
			metered: { meterNames: [...meterNames].sort() },
		};
		current.updatedAt = new Date();
		return structuredClone(current);
	}

	async startTrialIfUnset(id: string, startedAt: Date): Promise<License> {
		const current = this.records.get(id);
		if (!current) throw new Error("License not found");
		if (current.type === "trial" && !current.trialStartedAt) {
			current.trialStartedAt = startedAt;
			current.updatedAt = startedAt;
		}
		return structuredClone(current);
	}

	private withAllowlists(license: License): LicenseWithAllowlists {
		return structuredClone({
			...license,
			allowedIps: this.access.allowedIps.get(license.id) ?? [],
			allowedDevices: this.access.allowedDevices.get(license.id) ?? [],
		});
	}
}

class MemoryDeviceRepository implements IDeviceRepository {
	readonly records: RegisteredDevice[] = [];
	private readonly locks = new Map<string, Promise<void>>();

	constructor(private readonly licenses: () => MemoryLicenseRepository) {}

	async withLicenseRegistrationLock<T>(
		licenseId: string,
		operation: (repository: IDeviceRepository) => Promise<T>,
	): Promise<T> {
		const previous = this.locks.get(licenseId) ?? Promise.resolve();
		let release = () => {};
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.locks.set(
			licenseId,
			previous.then(() => current),
		);
		await previous;
		try {
			return await operation(this);
		} finally {
			release();
		}
	}

	async findLicenseAdmissionPolicy(
		licenseId: string,
	): Promise<LicenseWithAllowlists | null> {
		return await this.licenses().findByIdWithAllowlists(licenseId);
	}

	async incrementLicenseSessionRevision(
		licenseId: string,
	): Promise<number | null> {
		const license = await this.licenses().incrementSessionRevision(licenseId);
		return license.sessionRevision;
	}

	async startTrialIfUnset(
		licenseId: string,
		startedAt: Date,
	): Promise<Date | null> {
		const license = await this.licenses().startTrialIfUnset(
			licenseId,
			startedAt,
		);
		return license.trialStartedAt;
	}

	async findRegisteredDevice(
		licenseId: string,
		ip: string,
		deviceId: string,
	): Promise<RegisteredDevice | null> {
		return structuredClone(
			this.records.find(
				(device) =>
					device.licenseId === licenseId &&
					device.ip === ip &&
					device.deviceId === deviceId,
			) ?? null,
		);
	}

	async registerDevice(
		licenseId: string,
		ip: string,
		deviceId: string,
	): Promise<RegisteredDevice> {
		const existing = await this.findRegisteredDevice(licenseId, ip, deviceId);
		if (existing) return existing;
		const now = new Date();
		const device = {
			id: crypto.randomUUID(),
			licenseId,
			ip,
			deviceId,
			createdAt: now,
			lastSeenAt: now,
		};
		this.records.push(device);
		return structuredClone(device);
	}

	async touchDevice(id: string, seenAt: Date): Promise<void> {
		const device = this.records.find((candidate) => candidate.id === id);
		if (device) device.lastSeenAt = seenAt;
	}

	async getLicenseDeviceUsage(
		licenseId: string,
		ip: string,
		deviceId: string,
	): Promise<LicenseDeviceUsage> {
		const records = this.records.filter(
			(device) => device.licenseId === licenseId,
		);
		return {
			uniqueIps: new Set(records.map((device) => device.ip)).size,
			uniqueDevices: new Set(records.map((device) => device.deviceId)).size,
			ipRegistered: records.some((device) => device.ip === ip),
			deviceRegistered: records.some((device) => device.deviceId === deviceId),
		};
	}

	async removeRegisteredDevice(
		licenseId: string,
		registeredDeviceId: string,
	): Promise<boolean> {
		const index = this.records.findIndex(
			(device) =>
				device.licenseId === licenseId && device.id === registeredDeviceId,
		);
		if (index < 0) return false;
		this.records.splice(index, 1);
		return true;
	}

	async removeRegistrationsByIp(
		licenseId: string,
		ip: string,
	): Promise<number> {
		return this.removeWhere(
			(device) => device.licenseId === licenseId && device.ip === ip,
		);
	}

	async removeRegistrationsByDevice(
		licenseId: string,
		deviceId: string,
	): Promise<number> {
		return this.removeWhere(
			(device) =>
				device.licenseId === licenseId && device.deviceId === deviceId,
		);
	}

	async resetRegisteredDevices(licenseId: string): Promise<number> {
		return this.removeWhere((device) => device.licenseId === licenseId);
	}

	private removeWhere(
		predicate: (device: RegisteredDevice) => boolean,
	): number {
		let removed = 0;
		for (let index = this.records.length - 1; index >= 0; index--) {
			const device = this.records[index];
			if (device && predicate(device)) {
				this.records.splice(index, 1);
				removed++;
			}
		}
		return removed;
	}
}

class MemorySessionRepository implements ISessionRepository {
	readonly records = new Map<
		string,
		{ licenseId: string; sessionRevision: number; binding: SessionBinding }
	>();

	async registerSession(
		licenseId: string,
		sessionRevision: number,
		binding: SessionBinding,
		_ttlSeconds: number,
		maxSessions: number,
	): Promise<SessionRegistrationResult> {
		const count = [...this.records.values()].filter(
			(session) => session.licenseId === licenseId,
		).length;
		if (maxSessions > 0 && count >= maxSessions) {
			return { status: "limit-reached" };
		}
		const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
		this.records.set(token, {
			licenseId,
			sessionRevision,
			binding: { ...binding },
		});
		return { status: "registered", token };
	}

	async refreshSession(
		sessionToken: string,
		binding: SessionBinding,
		_ttlSeconds: number,
	): Promise<ResolvedSession | null> {
		const session = this.records.get(sessionToken);
		return session && this.matches(session.binding, binding)
			? {
					licenseId: session.licenseId,
					sessionRevision: session.sessionRevision,
					token: sessionToken,
				}
			: null;
	}

	async removeSession(
		sessionToken: string,
		binding: SessionBinding,
	): Promise<ResolvedSession | null> {
		const session = this.records.get(sessionToken);
		if (!session || !this.matches(session.binding, binding)) return null;
		this.records.delete(sessionToken);
		return {
			licenseId: session.licenseId,
			sessionRevision: session.sessionRevision,
			token: sessionToken,
		};
	}

	async removeAllSessions(licenseId: string): Promise<number> {
		let removed = 0;
		for (const [token, session] of this.records) {
			if (session.licenseId === licenseId) {
				this.records.delete(token);
				removed++;
			}
		}
		return removed;
	}

	count(licenseId: string): number {
		return [...this.records.values()].filter(
			(session) => session.licenseId === licenseId,
		).length;
	}

	private matches(left: SessionBinding, right: SessionBinding): boolean {
		return left.ip === right.ip && left.deviceId === right.deviceId;
	}
}

function createHarness() {
	const customers = new MemoryCustomerRepository();
	let licenses: MemoryLicenseRepository;
	const devices = new MemoryDeviceRepository(() => licenses);
	const access = new MemoryAccessRepository(() => devices.records);
	const meters = new MemoryMeterRepository();
	licenses = new MemoryLicenseRepository(access, meters);
	const sessions = new MemorySessionRepository();
	const admin = new AdminService(
		licenses,
		customers,
		access,
		devices,
		sessions,
		meters,
	);
	const licensing = new LicenseService(licenses, devices, sessions, meters);
	const app = new Elysia().use(licensePlugin(licensing));
	return { devices, meters, licenses, sessions, admin, licensing, app };
}

function hasRequestCode(error: unknown, code: string): boolean {
	return error instanceof LicenseRequestError && error.code === code;
}

async function expectRequestCode(
	promise: Promise<unknown>,
	code: string,
): Promise<void> {
	try {
		await promise;
		throw new Error(`Expected ${code}`);
	} catch (error) {
		expect(hasRequestCode(error, code)).toBeTrue();
	}
}

describe("canonical admin -> HTTP -> SDK product flow", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = global.fetch;
	});

	afterEach(() => {
		global.fetch = originalFetch;
	});

	test("runs lifetime, subscription, metered, and trial licenses", async () => {
		const harness = createHarness();
		global.fetch = ((
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) =>
			harness.app.handle(
				input instanceof Request
					? input
					: new Request(input.toString(), init as RequestInit | undefined),
			)) as typeof fetch;
		const customer = await harness.admin.createCustomer(
			"Owner@Example.com",
			"Owner",
		);

		const lifetime = await harness.admin.createLicense({
			customerId: customer.id,
			type: "lifetime",
			metadata: { plan: "forever" },
		});
		const lifetimeClient = new LicenseClient({
			licenseKey: lifetime.licenseKey,
			serverUrl: "http://127.0.0.1",
			deviceId: "lifetime-device",
		});
		expect(await lifetimeClient.activate()).toEqual({
			licenseType: "lifetime",
			metadata: { plan: "forever" },
		});
		await lifetimeClient.deactivate();

		const subscription = await harness.admin.createLicense({
			customerId: customer.id,
			type: "subscription",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		});
		const subscriptionClient = new LicenseClient({
			licenseKey: subscription.licenseKey,
			serverUrl: "http://127.0.0.1",
			deviceId: "subscription-device",
		});
		expect((await subscriptionClient.activate()).licenseType).toBe(
			"subscription",
		);
		await subscriptionClient.deactivate();

		const metered = await harness.admin.createLicense({
			customerId: customer.id,
			type: "metered",
			meters: [{ name: "credits", balance: 10, reason: "initial allowance" }],
		});
		const meteredClient = new LicenseClient({
			licenseKey: metered.licenseKey,
			serverUrl: "http://127.0.0.1",
			deviceId: "metered-device",
		});
		expect((await meteredClient.activate()).licenseType).toBe("metered");
		expect(
			await meteredClient.consume({
				meter: "credits",
				units: 4,
				eventId: "purchase-1",
			}),
		).toEqual({
			meter: "credits",
			units: 4,
			eventId: "purchase-1",
			remaining: 6,
		});
		expect(
			await meteredClient.consume({
				meter: "credits",
				units: 4,
				eventId: "purchase-1",
			}),
		).toMatchObject({ remaining: 6 });
		expect(harness.meters.ledger).toHaveLength(1);
		await expectRequestCode(
			meteredClient.consume({
				meter: "credits",
				units: 1,
				eventId: "purchase-1",
			}),
			"USAGE_EVENT_CONFLICT",
		);
		await expectRequestCode(
			meteredClient.consume({
				meter: "credits",
				units: 7,
				eventId: "purchase-2",
			}),
			"METER_EXHAUSTED",
		);
		await meteredClient.deactivate();

		const trial = await harness.admin.createLicense({
			customerId: customer.id,
			type: "trial",
			trialDurationMinutes: 15,
		});
		expect(
			(await harness.admin.getLicense(trial.id)).trialStartedAt,
		).toBeNull();
		const trialClient = new LicenseClient({
			licenseKey: trial.licenseKey,
			serverUrl: "http://127.0.0.1",
			deviceId: "trial-device",
		});
		expect((await trialClient.activate()).licenseType).toBe("trial");
		expect(
			(await harness.admin.getLicense(trial.id)).trialStartedAt,
		).toBeDate();
		await trialClient.deactivate();
		await harness.licenses.update(trial.id, {
			trialStartedAt: new Date(Date.now() - 16 * 60_000),
		});
		const expiredTrial = new LicenseClient({
			licenseKey: trial.licenseKey,
			serverUrl: "http://127.0.0.1",
			deviceId: "expired-trial-device",
		});
		await expectRequestCode(expiredTrial.activate(), "LICENSE_EXPIRED");
	});

	test("applies type, access, reset, revocation, and rotation changes immediately", async () => {
		const harness = createHarness();
		const customer = await harness.admin.createCustomer(
			"owner@example.com",
			"Owner",
		);
		const license = await harness.admin.createLicense({
			customerId: customer.id,
			type: "lifetime",
			maxIps: 1,
			maxDevices: 1,
			maxSessions: 2,
			metadata: { edition: "pro" },
		});

		const first = await harness.licensing.activate(
			license.licenseKey,
			"device-a",
			"203.0.113.10",
		);
		await harness.admin.updateLicense(license.id, {
			type: "subscription",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		});
		expect(
			await harness.licensing.heartbeat(
				first.sessionToken,
				"device-a",
				"203.0.113.10",
			),
		).toMatchObject({ licenseType: "subscription" });

		await harness.admin.updateLicense(license.id, {
			type: "trial",
			trialDurationMinutes: 30,
		});
		const switchedTrial = await harness.admin.getLicense(license.id);
		expect(switchedTrial.trialStartedAt).toBeDate();
		expect(
			await harness.licensing.heartbeat(
				first.sessionToken,
				"device-a",
				"203.0.113.10",
			),
		).toMatchObject({ licenseType: "trial" });
		await harness.admin.updateLicense(license.id, {
			type: "metered",
			meters: [{ name: "actions", balance: 3, reason: "type switch" }],
		});
		expect(
			await harness.licensing.heartbeat(
				first.sessionToken,
				"device-a",
				"203.0.113.10",
			),
		).toMatchObject({ licenseType: "metered" });
		expect(
			await harness.licensing.consume(
				first.sessionToken,
				"device-a",
				"203.0.113.10",
				{ meter: "actions", units: 1, eventId: "switch-usage" },
			),
		).toMatchObject({ remaining: 2 });
		await harness.admin.updateLicense(license.id, { type: "trial" });

		await expect(
			harness.licensing.heartbeat(
				first.sessionToken,
				"device-b",
				"203.0.113.10",
			),
		).rejects.toMatchObject({ code: "SESSION_INVALID_OR_EXPIRED" });

		const allowedIp = await harness.admin.allowLicenseIp(
			license.id,
			"203.0.113.10",
		);
		expect(allowedIp.restrictionEnabled).toBeTrue();
		expect(allowedIp.warning).toContain("restrictive");
		await expect(
			harness.licensing.activate(
				license.licenseKey,
				"device-a",
				"198.51.100.1",
			),
		).rejects.toMatchObject({ code: "IP_NOT_ALLOWED" });

		const allowedDevice = await harness.admin.allowLicenseDevice(
			license.id,
			"device-a",
		);
		expect(allowedDevice.restrictionEnabled).toBeTrue();
		await expect(
			harness.licensing.activate(
				license.licenseKey,
				"device-b",
				"203.0.113.10",
			),
		).rejects.toMatchObject({ code: "DEVICE_NOT_ALLOWED" });

		expect(await harness.admin.resetRegisteredDevices(license.id)).toBe(1);
		expect(harness.sessions.count(license.id)).toBe(0);
		await expect(
			harness.licensing.heartbeat(
				first.sessionToken,
				"device-a",
				"203.0.113.10",
			),
		).rejects.toMatchObject({ code: "SESSION_INVALID_OR_EXPIRED" });

		await harness.admin.revokeLicense(license.id, "fraud review");
		await expect(
			harness.licensing.activate(
				license.licenseKey,
				"device-a",
				"203.0.113.10",
			),
		).rejects.toMatchObject({ code: "LICENSE_REVOKED" });
		await harness.admin.restoreLicense(license.id);
		const restored = await harness.licensing.activate(
			license.licenseKey,
			"device-a",
			"203.0.113.10",
		);
		await harness.licensing.deactivate(
			restored.sessionToken,
			"device-a",
			"203.0.113.10",
		);

		const rotated = await harness.admin.rotateLicenseKey(license.id);
		expect(rotated.licenseKey).toStartWith("lic_");
		expect(rotated.licenseKey).not.toBe(license.licenseKey);
		await expect(
			harness.licensing.activate(
				license.licenseKey,
				"device-a",
				"203.0.113.10",
			),
		).rejects.toMatchObject({ code: "LICENSE_INVALID" });
		await expect(
			harness.licensing.activate(
				rotated.licenseKey,
				"device-a",
				"203.0.113.10",
			),
		).resolves.toMatchObject({ licenseType: "trial" });
	});

	test("serializes concurrent device registration at the configured limit", async () => {
		const harness = createHarness();
		const customer = await harness.admin.createCustomer(
			"owner@example.com",
			"Owner",
		);
		const license = await harness.admin.createLicense({
			customerId: customer.id,
			type: "lifetime",
			maxDevices: 1,
		});

		const results = await Promise.allSettled([
			harness.licensing.activate(
				license.licenseKey,
				"device-a",
				"203.0.113.10",
			),
			harness.licensing.activate(
				license.licenseKey,
				"device-b",
				"203.0.113.10",
			),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		expect(harness.devices.records).toHaveLength(1);
	});
});
