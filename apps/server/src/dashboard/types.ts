export type DashboardMaybePromise<T> = T | Promise<T>;

export type DashboardJson =
	| null
	| boolean
	| number
	| string
	| DashboardJson[]
	| { [key: string]: DashboardJson };

export type DashboardLicenseType =
	| "lifetime"
	| "subscription"
	| "metered"
	| "trial";

export type DashboardLicenseState = "active" | "expired" | "revoked";

export interface DashboardCustomer {
	id: string;
	name: string;
	email: string;
	metadata: Record<string, DashboardJson>;
	licenseCount?: number;
	createdAt: string | Date;
	updatedAt?: string | Date;
}

export interface DashboardMeter {
	name: string;
	balance: number;
	archivedAt?: string | Date | null;
	createdAt?: string | Date;
}

export interface DashboardStripeLink {
	subscriptionId: string;
	status: string;
	paidThrough?: string | Date | null;
	cancelAtPeriodEnd?: boolean;
	lastSyncedAt?: string | Date | null;
}

export interface DashboardLicense {
	id: string;
	customerId: string;
	type: DashboardLicenseType;
	keyPrefix: string;
	status: {
		status: DashboardLicenseState;
		reason?: string | null;
	};
	maxIps: number;
	maxDevices: number;
	maxSessions: number;
	expiresAt?: string | Date | null;
	trialDurationMinutes?: number | null;
	trialStartedAt?: string | Date | null;
	typeDrafts?: {
		lifetime?: Record<string, DashboardJson>;
		subscription?: { expiresAt: string | null };
		metered?: { meterNames: string[] };
		trial?: { durationMinutes: number };
	};
	metadata: Record<string, DashboardJson>;
	meters?: DashboardMeter[];
	stripe?: DashboardStripeLink | null;
	createdAt: string | Date;
	updatedAt?: string | Date;
}

export interface DashboardCreatedLicense extends DashboardLicense {
	licenseKey: string;
}

export interface DashboardCustomerInput {
	name: string;
	email: string;
	metadata?: Record<string, DashboardJson>;
}

export interface DashboardLicenseInput {
	customerId: string;
	type: DashboardLicenseType;
	maxIps: number;
	maxDevices: number;
	maxSessions: number;
	expiresAt?: string | null;
	trialDurationMinutes?: number | null;
	metadata?: Record<string, DashboardJson>;
	meters?: Array<{ name: string; balance: number; reason: string }>;
}

export interface DashboardLicensePatch extends Partial<DashboardLicenseInput> {
	confirmStripeUnlink?: boolean;
}

export interface DashboardListFilters {
	search?: string;
	customerId?: string;
	licenseId?: string;
	type?: DashboardLicenseType;
	status?: DashboardLicenseState;
	from?: string;
	to?: string;
}

export interface DashboardAccessIdentifier {
	value: string;
	registeredAt?: string | Date;
	lastSeenAt?: string | Date;
}

export interface DashboardDeviceIdentifier {
	deviceId: string;
	registeredAt?: string | Date;
	lastSeenAt?: string | Date;
}

export interface DashboardAttemptedIdentifier {
	value: string;
	attemptCount: number;
	firstAttemptedAt: string | Date;
	lastAttemptedAt: string | Date;
}

export interface DashboardActiveSession {
	id: string;
	deviceId?: string | null;
	ip?: string | null;
	expiresAt?: string | Date | null;
}

export interface DashboardLicenseAccess {
	registeredIps: DashboardAccessIdentifier[];
	registeredDevices: DashboardDeviceIdentifier[];
	ipAllowlist: string[];
	deviceAllowlist: string[];
	attemptedIps: DashboardAttemptedIdentifier[];
	attemptedDevices: DashboardAttemptedIdentifier[];
	activeSessions: DashboardActiveSession[];
}

export type DashboardActivityKind =
	| "customer.created"
	| "customer.updated"
	| "customer.deleted"
	| "license.created"
	| "license.updated"
	| "license.type_changed"
	| "license.deleted"
	| "license.revoked"
	| "license.restored"
	| "license.key_rotated"
	| "license.activation_attempted"
	| "license.activation_succeeded"
	| "license.activation_rejected"
	| "license.heartbeat"
	| "license.deactivated"
	| "usage.consumed"
	| "usage.rejected"
	| "meter.created"
	| "meter.archived"
	| "meter.adjusted"
	| "stripe.linked"
	| "stripe.unlinked"
	| "stripe.synchronized"
	| "stripe.webhook_failed";

export type DashboardActivitySourceName =
	| "operator"
	| "client"
	| "stripe"
	| "system";

export type DashboardActivityOutcome = "success" | "rejected" | "error";

export interface DashboardActivity {
	id: string;
	type: DashboardActivityKind;
	source: DashboardActivitySourceName;
	outcome: DashboardActivityOutcome;
	reason?: string | null;
	customerId?: string | null;
	licenseId?: string | null;
	keyPrefix?: string | null;
	details?: Record<string, DashboardJson>;
	createdAt: string | Date;
}

export interface DashboardStatistics {
	totals: Array<{
		scope: "global" | "customer" | "license";
		scopeId: string;
		type: DashboardActivityKind;
		count: number;
	}>;
	buckets: Array<{
		minute: string | Date;
		scope: "global" | "customer" | "license";
		scopeId: string;
		type: DashboardActivityKind;
		count: number;
	}>;
	recent: DashboardActivity[];
}

export interface DashboardCustomerApi {
	list(
		filters: DashboardListFilters,
	): DashboardMaybePromise<DashboardCustomer[]>;
	get(id: string): DashboardMaybePromise<DashboardCustomer>;
	create(
		input: DashboardCustomerInput,
	): DashboardMaybePromise<DashboardCustomer>;
	update(
		id: string,
		input: Partial<DashboardCustomerInput>,
	): DashboardMaybePromise<DashboardCustomer>;
	delete(id: string): DashboardMaybePromise<void>;
}

export interface DashboardLicenseApi {
	list(
		filters: DashboardListFilters,
	): DashboardMaybePromise<DashboardLicense[]>;
	get(id: string): DashboardMaybePromise<DashboardLicense>;
	create(
		input: DashboardLicenseInput,
	): DashboardMaybePromise<DashboardCreatedLicense>;
	update(
		id: string,
		input: DashboardLicensePatch,
	): DashboardMaybePromise<DashboardLicense>;
	delete(id: string): DashboardMaybePromise<void>;
	revoke(id: string, reason: string): DashboardMaybePromise<DashboardLicense>;
	restore(id: string): DashboardMaybePromise<DashboardLicense>;
	rotate(
		id: string,
	): DashboardMaybePromise<{ licenseKey: string; keyPrefix: string }>;
	terminateSessions(id: string): DashboardMaybePromise<{ terminated: number }>;
	resetDevices(id: string): DashboardMaybePromise<{ removed: number }>;
	access(id: string): DashboardMaybePromise<DashboardLicenseAccess>;
	addIpAllowlist(
		id: string,
		value: string,
	): DashboardMaybePromise<DashboardLicenseAccess>;
	removeIpAllowlist(
		id: string,
		value: string,
	): DashboardMaybePromise<DashboardLicenseAccess>;
	addDeviceAllowlist(
		id: string,
		deviceId: string,
	): DashboardMaybePromise<DashboardLicenseAccess>;
	removeDeviceAllowlist(
		id: string,
		deviceId: string,
	): DashboardMaybePromise<DashboardLicenseAccess>;
	removeRegisteredIp(
		id: string,
		value: string,
	): DashboardMaybePromise<DashboardLicenseAccess>;
	removeRegisteredDevice(
		id: string,
		deviceId: string,
	): DashboardMaybePromise<DashboardLicenseAccess>;
	meters(id: string): DashboardMaybePromise<DashboardMeter[]>;
	createMeter(
		id: string,
		input: { name: string; balance: number; reason: string },
	): DashboardMaybePromise<DashboardMeter[]>;
	archiveMeter(
		id: string,
		name: string,
		reason: string,
	): DashboardMaybePromise<DashboardMeter[]>;
	adjustMeter(
		id: string,
		name: string,
		input: { delta: number; reason: string },
	): DashboardMaybePromise<DashboardMeter[]>;
}

export interface DashboardStripeApi {
	state(): DashboardMaybePromise<{ enabled: true }>;
	link(
		licenseId: string,
		subscriptionId: string,
	): DashboardMaybePromise<DashboardLicense>;
	sync(licenseId: string): DashboardMaybePromise<DashboardLicense>;
	unlink(licenseId: string): DashboardMaybePromise<DashboardLicense>;
}

export interface DashboardApi {
	customers: DashboardCustomerApi;
	licenses: DashboardLicenseApi;
	statistics(
		filters: DashboardListFilters,
	): DashboardMaybePromise<DashboardStatistics>;
	stripe?: DashboardStripeApi;
}

export interface DashboardActivitySource {
	subscribe(listener: (activity: DashboardActivity) => void): () => void;
}

export class DashboardActivityHub implements DashboardActivitySource {
	private readonly listeners = new Set<(activity: DashboardActivity) => void>();

	publish(activity: DashboardActivity): void {
		for (const listener of this.listeners) listener(activity);
	}

	subscribe(listener: (activity: DashboardActivity) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

export interface DashboardRedis {
	send(command: string, args: string[]): Promise<unknown>;
}

export interface DashboardConfig {
	username: string;
	password: string;
	secureCookies: boolean;
	sessionTtlMinutes: number;
	loginWindowSeconds?: number;
	maxLoginAttempts?: number;
}

export interface DashboardOptions {
	config: DashboardConfig;
	redis: DashboardRedis;
	api: DashboardApi;
	activity: DashboardActivitySource;
	resolveClientIp?: (
		request: Request,
		server: { requestIP(request: Request): { address: string } | null } | null,
	) => string;
	now?: () => number;
}

export class DashboardHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "DashboardHttpError";
	}
}
