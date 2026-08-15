import {
	DashboardHttpError,
	type DashboardCustomerInput,
	type DashboardJson,
	type DashboardLicenseInput,
	type DashboardLicensePatch,
	type DashboardLicenseType,
	type DashboardListFilters,
} from "./types";

type InputObject = Record<string, unknown>;

const LICENSE_TYPES = new Set<DashboardLicenseType>([
	"lifetime",
	"subscription",
	"metered",
	"trial",
]);

const LEGACY_FIELDS = new Set([
	"apiKey",
	"customFields",
	"hwid",
	"limitConcurrent",
	"limitHwid",
	"limitIp",
	"limitUsage",
	"trialDurationMin",
	"trialDurationSeconds",
	"userId",
]);

export function inputObject(body: unknown): InputObject {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new DashboardHttpError(400, "Request body must be a JSON object.");
	}
	const input = body as InputObject;
	for (const field of Object.keys(input)) {
		if (LEGACY_FIELDS.has(field)) {
			throw new DashboardHttpError(
				400,
				`Legacy field '${field}' is not supported by the dashboard API.`,
			);
		}
	}
	return input;
}

function stringValue(
	input: InputObject,
	name: string,
	options: { required?: boolean; nullable?: boolean; maximum?: number } = {},
): string | null | undefined {
	const value = input[name];
	if (value === undefined) {
		if (options.required) {
			throw new DashboardHttpError(400, `${name} is required.`);
		}
		return undefined;
	}
	if (value === null && options.nullable) return null;
	if (typeof value !== "string") {
		throw new DashboardHttpError(400, `${name} must be a string.`);
	}
	const result = value.trim();
	if (!result && options.required) {
		throw new DashboardHttpError(400, `${name} is required.`);
	}
	if (result.length > (options.maximum ?? 1_024)) {
		throw new DashboardHttpError(400, `${name} is too long.`);
	}
	return result;
}

function integerValue(
	input: InputObject,
	name: string,
	options: { required?: boolean; minimum?: number; maximum?: number } = {},
): number | undefined {
	const value = input[name];
	if (value === undefined) {
		if (options.required) {
			throw new DashboardHttpError(400, `${name} is required.`);
		}
		return undefined;
	}
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < (options.minimum ?? 0) ||
		value > (options.maximum ?? 2_147_483_647)
	) {
		throw new DashboardHttpError(400, `${name} is outside its valid range.`);
	}
	return value;
}

function metadataValue(
	input: InputObject,
): Record<string, DashboardJson> | undefined {
	if (input.metadata === undefined) return undefined;
	if (
		!input.metadata ||
		typeof input.metadata !== "object" ||
		Array.isArray(input.metadata)
	) {
		throw new DashboardHttpError(400, "metadata must be a JSON object.");
	}
	return input.metadata as Record<string, DashboardJson>;
}

export function customerInput(
	body: unknown,
	partial?: false,
): DashboardCustomerInput;
export function customerInput(
	body: unknown,
	partial: true,
): Partial<DashboardCustomerInput>;
export function customerInput(
	body: unknown,
	partial = false,
): DashboardCustomerInput | Partial<DashboardCustomerInput> {
	const input = inputObject(body);
	const name = stringValue(input, "name", {
		required: !partial,
		maximum: 200,
	});
	const email = stringValue(input, "email", {
		required: !partial,
		maximum: 254,
	});
	if (email !== undefined && !email) {
		throw new DashboardHttpError(400, "email is required.");
	}
	const metadata = metadataValue(input);
	return {
		...(name !== undefined ? { name: name as string } : {}),
		...(email !== undefined ? { email } : {}),
		...(metadata !== undefined ? { metadata } : {}),
	};
}

function licenseType(
	input: InputObject,
	required: boolean,
): DashboardLicenseType | undefined {
	const value = stringValue(input, "type", { required, maximum: 32 });
	if (value === undefined) return undefined;
	if (!LICENSE_TYPES.has(value as DashboardLicenseType)) {
		throw new DashboardHttpError(
			400,
			"type must be lifetime, subscription, metered, or trial.",
		);
	}
	return value as DashboardLicenseType;
}

function meterInputs(
	input: InputObject,
): Array<{ name: string; balance: number; reason: string }> | undefined {
	if (input.meters === undefined) return undefined;
	if (!Array.isArray(input.meters)) {
		throw new DashboardHttpError(400, "meters must be an array.");
	}
	const names = new Set<string>();
	return input.meters.map((value) => {
		const meter = inputObject(value);
		const name = stringValue(meter, "name", {
			required: true,
			maximum: 128,
		}) as string;
		if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
			throw new DashboardHttpError(
				400,
				"Meter names must start with a lowercase letter and contain only lowercase letters, numbers, underscores, or hyphens.",
			);
		}
		if (names.has(name)) {
			throw new DashboardHttpError(400, `Duplicate meter name '${name}'.`);
		}
		names.add(name);
		return {
			name,
			balance: integerValue(meter, "balance", {
				required: true,
				minimum: 0,
				maximum: Number.MAX_SAFE_INTEGER,
			}) as number,
			reason: stringValue(meter, "reason", {
				required: true,
				maximum: 500,
			}) as string,
		};
	});
}

export function licenseInput(
	body: unknown,
	partial?: false,
): DashboardLicenseInput;
export function licenseInput(
	body: unknown,
	partial: true,
): DashboardLicensePatch;
export function licenseInput(
	body: unknown,
	partial = false,
): DashboardLicenseInput | DashboardLicensePatch {
	const input = inputObject(body);
	const customerId = stringValue(input, "customerId", {
		required: !partial,
		maximum: 128,
	});
	const type = licenseType(input, !partial);
	const maxIps = integerValue(input, "maxIps", { required: !partial });
	const maxDevices = integerValue(input, "maxDevices", { required: !partial });
	const maxSessions = integerValue(input, "maxSessions", {
		required: !partial,
	});
	const expiresAt = stringValue(input, "expiresAt", {
		nullable: true,
		maximum: 64,
	});
	const trialDurationMinutes = integerValue(input, "trialDurationMinutes", {
		minimum: 1,
		maximum: 525_600,
	});
	const metadata = metadataValue(input);
	const meters = meterInputs(input);
	if (!partial && type === "subscription" && !expiresAt) {
		throw new DashboardHttpError(
			400,
			"expiresAt is required for subscription licenses.",
		);
	}
	if (!partial && type === "trial" && !trialDurationMinutes) {
		throw new DashboardHttpError(
			400,
			"trialDurationMinutes is required for trial licenses.",
		);
	}
	if (!partial && type === "metered" && (!meters || meters.length === 0)) {
		throw new DashboardHttpError(
			400,
			"At least one meter is required for metered licenses.",
		);
	}
	const confirmStripeUnlink = input.confirmStripeUnlink;
	if (
		confirmStripeUnlink !== undefined &&
		typeof confirmStripeUnlink !== "boolean"
	) {
		throw new DashboardHttpError(400, "confirmStripeUnlink must be a boolean.");
	}
	return {
		...(customerId !== undefined ? { customerId } : {}),
		...(type !== undefined ? { type } : {}),
		...(maxIps !== undefined ? { maxIps } : {}),
		...(maxDevices !== undefined ? { maxDevices } : {}),
		...(maxSessions !== undefined ? { maxSessions } : {}),
		...(expiresAt !== undefined ? { expiresAt } : {}),
		...(trialDurationMinutes !== undefined ? { trialDurationMinutes } : {}),
		...(metadata !== undefined ? { metadata } : {}),
		...(meters !== undefined ? { meters } : {}),
		...(confirmStripeUnlink !== undefined ? { confirmStripeUnlink } : {}),
	} as DashboardLicenseInput | DashboardLicensePatch;
}

export function stringBody(body: unknown, name: string, maximum = 512): string {
	return stringValue(inputObject(body), name, {
		required: true,
		maximum,
	}) as string;
}

export function meterAdjustment(body: unknown): {
	delta: number;
	reason: string;
} {
	const input = inputObject(body);
	const delta = integerValue(input, "delta", {
		required: true,
		minimum: -Number.MAX_SAFE_INTEGER,
		maximum: Number.MAX_SAFE_INTEGER,
	}) as number;
	if (delta === 0) {
		throw new DashboardHttpError(400, "delta cannot be zero.");
	}
	return {
		delta,
		reason: stringValue(input, "reason", {
			required: true,
			maximum: 500,
		}) as string,
	};
}

export function meterCreation(body: unknown): {
	name: string;
	balance: number;
	reason: string;
} {
	const meters = meterInputs({ meters: [body] });
	if (!meters?.[0]) throw new DashboardHttpError(400, "Invalid meter.");
	return meters[0];
}

export function listFilters(request: Request): DashboardListFilters {
	const search = new URL(request.url).searchParams;
	const type = search.get("type") || undefined;
	const status = search.get("status") || undefined;
	if (type && !LICENSE_TYPES.has(type as DashboardLicenseType)) {
		throw new DashboardHttpError(400, "Invalid license type filter.");
	}
	if (status && !["active", "expired", "revoked"].includes(status)) {
		throw new DashboardHttpError(400, "Invalid license status filter.");
	}
	const bounded = (name: string, maximum: number) => {
		const value = search.get(name)?.trim();
		if (!value) return undefined;
		if (value.length > maximum) {
			throw new DashboardHttpError(400, `${name} filter is too long.`);
		}
		return value;
	};
	return {
		search: bounded("search", 200),
		customerId: bounded("customerId", 128),
		licenseId: bounded("licenseId", 128),
		type: type as DashboardLicenseType | undefined,
		status: status as DashboardListFilters["status"],
		from: bounded("from", 64),
		to: bounded("to", 64),
	};
}
