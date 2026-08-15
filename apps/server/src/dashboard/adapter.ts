import type {
	AdminService,
	ManagedLicense,
	ManagedRevealedLicense,
	UpdateLicenseInput,
} from "../application/services/AdminService";
import type { ActivityService } from "../application/services/ActivityService";
import type { JsonObject, RegisteredDevice } from "../domain/entities";
import { DomainError } from "../domain/errors";
import type { AccessRecords } from "../domain/repositories/IAccessRepository";
import type { StripeSubscriptionService } from "../integrations/stripe";
import type {
	DashboardAccessIdentifier,
	DashboardApi,
	DashboardCustomer,
	DashboardDeviceIdentifier,
	DashboardLicense,
	DashboardLicenseAccess,
	DashboardLicenseInput,
	DashboardLicensePatch,
	DashboardListFilters,
} from "./types";

function metadata(value: JsonObject) {
	return value as DashboardLicense["metadata"];
}

function parseFilterDate(value: string | undefined, name: string) {
	if (!value) return undefined;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		throw new DomainError(`${name} must be a valid ISO date`);
	}
	return date;
}

function registeredIps(
	devices: RegisteredDevice[],
): DashboardAccessIdentifier[] {
	const values = new Map<string, DashboardAccessIdentifier>();
	for (const device of devices) {
		const current = values.get(device.ip);
		if (!current) {
			values.set(device.ip, {
				value: device.ip,
				registeredAt: device.createdAt,
				lastSeenAt: device.lastSeenAt,
			});
			continue;
		}
		if (
			current.registeredAt instanceof Date &&
			device.createdAt < current.registeredAt
		) {
			current.registeredAt = device.createdAt;
		}
		if (
			current.lastSeenAt instanceof Date &&
			device.lastSeenAt > current.lastSeenAt
		) {
			current.lastSeenAt = device.lastSeenAt;
		}
	}
	return [...values.values()].sort((left, right) =>
		left.value.localeCompare(right.value),
	);
}

function registeredDeviceIds(
	devices: RegisteredDevice[],
): DashboardDeviceIdentifier[] {
	const values = new Map<string, DashboardDeviceIdentifier>();
	for (const device of devices) {
		const current = values.get(device.deviceId);
		if (!current) {
			values.set(device.deviceId, {
				deviceId: device.deviceId,
				registeredAt: device.createdAt,
				lastSeenAt: device.lastSeenAt,
			});
			continue;
		}
		if (
			current.registeredAt instanceof Date &&
			device.createdAt < current.registeredAt
		) {
			current.registeredAt = device.createdAt;
		}
		if (
			current.lastSeenAt instanceof Date &&
			device.lastSeenAt > current.lastSeenAt
		) {
			current.lastSeenAt = device.lastSeenAt;
		}
	}
	return [...values.values()].sort((left, right) =>
		left.deviceId.localeCompare(right.deviceId),
	);
}

function access(records: AccessRecords): DashboardLicenseAccess {
	return {
		registeredIps: registeredIps(records.registeredDevices),
		registeredDevices: registeredDeviceIds(records.registeredDevices),
		ipAllowlist: records.allowedIps.map((entry) => entry.ip).sort(),
		deviceAllowlist: records.allowedDevices
			.map((entry) => entry.deviceId)
			.sort(),
		attemptedIps: records.attemptedIps,
		attemptedDevices: records.attemptedDevices,
		// Session identifiers are intentionally opaque in Redis. Operators can
		// terminate every active session without exposing bearer tokens.
		activeSessions: [],
	};
}

function customer(value: Awaited<ReturnType<AdminService["getCustomer"]>>) {
	return {
		...value,
		metadata: value.metadata as DashboardCustomer["metadata"],
	};
}

function licenseInput(input: DashboardLicenseInput) {
	return {
		customerId: input.customerId,
		type: input.type,
		maxIps: input.maxIps,
		maxDevices: input.maxDevices,
		maxSessions: input.maxSessions,
		...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
		...(input.trialDurationMinutes
			? { trialDurationMinutes: input.trialDurationMinutes }
			: {}),
		...(input.metadata ? { metadata: input.metadata as JsonObject } : {}),
		...(input.meters ? { meters: input.meters } : {}),
	};
}

function licensePatch(input: DashboardLicensePatch): UpdateLicenseInput {
	const {
		confirmStripeUnlink,
		customerId,
		type,
		maxIps,
		maxDevices,
		maxSessions,
		expiresAt,
		trialDurationMinutes,
		metadata: licenseMetadata,
		meters,
	} = input;
	return {
		...(customerId !== undefined ? { customerId } : {}),
		...(type !== undefined ? { type } : {}),
		...(maxIps !== undefined ? { maxIps } : {}),
		...(maxDevices !== undefined ? { maxDevices } : {}),
		...(maxSessions !== undefined ? { maxSessions } : {}),
		...(expiresAt !== undefined ? { expiresAt } : {}),
		...(trialDurationMinutes !== undefined && trialDurationMinutes !== null
			? { trialDurationMinutes }
			: {}),
		...(licenseMetadata !== undefined
			? { metadata: licenseMetadata as JsonObject }
			: {}),
		...(meters !== undefined ? { meters } : {}),
		...(confirmStripeUnlink ? { unlinkStripe: true } : {}),
	};
}

export function createDashboardApi(
	admin: AdminService,
	activity: ActivityService,
	stripe?: StripeSubscriptionService,
): DashboardApi {
	const presentLicense = async (
		value: ManagedLicense | ManagedRevealedLicense,
	): Promise<DashboardLicense> => {
		const [meters, stripeLink] = await Promise.all([
			admin.listLicenseMeters(value.id, true),
			stripe?.getLink(value.id) ?? null,
		]);
		return {
			id: value.id,
			customerId: value.customerId,
			type: value.type,
			keyPrefix: value.keyPrefix,
			status: { status: value.status, reason: value.statusReason },
			maxIps: value.maxIps,
			maxDevices: value.maxDevices,
			maxSessions: value.maxSessions,
			expiresAt: value.expiresAt,
			trialDurationMinutes: value.trialDurationMinutes,
			trialStartedAt: value.trialStartedAt,
			typeDrafts: value.typeDrafts,
			metadata: metadata(value.metadata),
			meters: meters.map((meter) => ({
				name: meter.name,
				balance: meter.balance,
				archivedAt: meter.archivedAt,
				createdAt: meter.createdAt,
			})),
			stripe: stripeLink
				? {
						subscriptionId: stripeLink.subscriptionId,
						status: stripeLink.status,
						paidThrough: stripeLink.paidThrough,
						cancelAtPeriodEnd: stripeLink.cancelAtPeriodEnd,
						lastSyncedAt: stripeLink.lastSyncedAt,
					}
				: null,
			createdAt: value.createdAt,
			updatedAt: value.updatedAt,
		};
	};

	const getLicense = async (id: string) =>
		await presentLicense(await admin.getLicense(id));
	const getAccess = async (id: string) =>
		access(await admin.getLicenseAccess(id));
	const getMeters = async (id: string) =>
		(await admin.listLicenseMeters(id, true)).map((meter) => ({
			name: meter.name,
			balance: meter.balance,
			archivedAt: meter.archivedAt,
			createdAt: meter.createdAt,
		}));

	const api: DashboardApi = {
		customers: {
			list: async (filters) => {
				const [customers, licenses] = await Promise.all([
					admin.listCustomers(),
					admin.listLicenses(),
				]);
				const search = filters.search?.toLocaleLowerCase();
				return customers
					.filter(
						(value) =>
							!search ||
							value.id.toLocaleLowerCase().includes(search) ||
							value.name.toLocaleLowerCase().includes(search) ||
							value.email.toLocaleLowerCase().includes(search),
					)
					.map((value) => ({
						...customer(value),
						licenseCount: licenses.filter(
							(license) => license.customerId === value.id,
						).length,
					}));
			},
			get: async (id) => customer(await admin.getCustomer(id)),
			create: async (input) =>
				customer(
					await admin.createCustomer(
						input.email,
						input.name,
						(input.metadata ?? {}) as JsonObject,
					),
				),
			update: async (id, input) =>
				customer(
					await admin.updateCustomer(id, {
						...input,
						...(input.metadata
							? { metadata: input.metadata as JsonObject }
							: {}),
					}),
				),
			delete: (id) => admin.deleteCustomer(id),
		},
		licenses: {
			list: async (filters) => {
				const values = await admin.listLicenses();
				const search = filters.search?.toLocaleLowerCase();
				return await Promise.all(
					values
						.filter(
							(value) =>
								(!filters.customerId ||
									value.customerId === filters.customerId) &&
								(!filters.licenseId || value.id === filters.licenseId) &&
								(!filters.type || value.type === filters.type) &&
								(!filters.status || value.status === filters.status) &&
								(!search ||
									value.id.toLocaleLowerCase().includes(search) ||
									value.keyPrefix.toLocaleLowerCase().includes(search) ||
									value.customerId.toLocaleLowerCase().includes(search)),
						)
						.map(presentLicense),
				);
			},
			get: getLicense,
			create: async (input) => {
				const created = await admin.createLicense(licenseInput(input));
				return {
					...(await presentLicense(created)),
					licenseKey: created.licenseKey,
				};
			},
			update: async (id, input) =>
				await presentLicense(
					await admin.updateLicense(id, licensePatch(input)),
				),
			delete: (id) => admin.deleteLicense(id),
			revoke: async (id, reason) =>
				await presentLicense(await admin.revokeLicense(id, reason)),
			restore: async (id) =>
				await presentLicense(await admin.restoreLicense(id)),
			rotate: async (id) => {
				const rotated = await admin.rotateLicenseKey(id);
				return {
					licenseKey: rotated.licenseKey,
					keyPrefix: rotated.keyPrefix,
				};
			},
			terminateSessions: async (id) => ({
				terminated: await admin.terminateLicenseSessions(id),
			}),
			resetDevices: async (id) => ({
				removed: await admin.resetRegisteredDevices(id),
			}),
			access: getAccess,
			addIpAllowlist: async (id, value) => {
				await admin.allowLicenseIp(id, value);
				return await getAccess(id);
			},
			removeIpAllowlist: async (id, value) => {
				await admin.removeLicenseAllowedIp(id, value);
				return await getAccess(id);
			},
			addDeviceAllowlist: async (id, deviceId) => {
				await admin.allowLicenseDevice(id, deviceId);
				return await getAccess(id);
			},
			removeDeviceAllowlist: async (id, deviceId) => {
				await admin.removeLicenseAllowedDevice(id, deviceId);
				return await getAccess(id);
			},
			removeRegisteredIp: async (id, value) => {
				await admin.removeRegisteredIp(id, value);
				return await getAccess(id);
			},
			removeRegisteredDevice: async (id, deviceId) => {
				await admin.removeRegisteredDevice(id, deviceId);
				return await getAccess(id);
			},
			meters: getMeters,
			createMeter: async (id, input) => {
				await admin.createLicenseMeter(id, input);
				return await getMeters(id);
			},
			archiveMeter: async (id, name, reason) => {
				await admin.archiveLicenseMeter(id, name, reason);
				return await getMeters(id);
			},
			adjustMeter: async (id, name, input) => {
				await admin.adjustLicenseMeter(id, name, input.delta, input.reason);
				return await getMeters(id);
			},
		},
		statistics: async (filters: DashboardListFilters) => {
			const statistics = await activity.getStatistics({
				...(filters.licenseId ? { licenseId: filters.licenseId } : {}),
				...(filters.customerId ? { customerId: filters.customerId } : {}),
				...(filters.from
					? { from: parseFilterDate(filters.from, "from") }
					: {}),
				...(filters.to ? { to: parseFilterDate(filters.to, "to") } : {}),
			});
			return statistics;
		},
	};

	if (stripe) {
		api.stripe = {
			state: () => ({ enabled: true }),
			link: async (licenseId, subscriptionId) => {
				await stripe.linkLicense(licenseId, subscriptionId);
				return await getLicense(licenseId);
			},
			sync: async (licenseId) => {
				await stripe.syncLicense(licenseId);
				return await getLicense(licenseId);
			},
			unlink: async (licenseId) => {
				await stripe.unlinkLicense(licenseId);
				return await getLicense(licenseId);
			},
		};
	}

	return api;
}
