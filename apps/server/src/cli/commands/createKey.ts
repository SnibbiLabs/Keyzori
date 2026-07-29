import type { Command } from "commander";
import type { JsonObject, JsonValue, KeyType } from "../../domain/entities";
import type { AdminOperations } from "../AdminOperations";
import { reportCommandError } from "../commandError";
import { MAX_LICENSE_LIMIT } from "../../domain/licenseLimits";

interface CreateKeyOptions {
	userId: string;
	type: KeyType;
	limitIp: number;
	limitHwid: number;
	limitConcurrent: number;
	limitUsage: number;
	trialDurationMin: number;
	customFields?: JsonObject;
	expiresAt?: string;
}

function parseNonNegativeInteger(value: string): number {
	if (!/^\d+$/.test(value)) {
		throw new Error(`Expected a non-negative integer, received "${value}".`);
	}
	const parsed = Number(value);
	if (parsed > MAX_LICENSE_LIMIT) {
		throw new Error(
			`Expected a value no greater than ${MAX_LICENSE_LIMIT}, received "${value}".`,
		);
	}
	return parsed;
}

function parseKeyType(value: string): KeyType {
	if (value === "PERPETUAL" || value === "SUBSCRIPTION" || value === "USAGE") {
		return value;
	}
	throw new Error("Type must be PERPETUAL, SUBSCRIPTION, or USAGE.");
}

function parseIsoDate(value: string): string {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		throw new Error(`Expected a valid ISO date, received "${value}".`);
	}
	return parsed.toISOString();
}

function isJsonValue(value: unknown): value is JsonValue {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return true;
	}
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	return isJsonObject(value);
}

function isJsonObject(value: unknown): value is JsonObject {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.values(value).every(isJsonValue)
	);
}

function parseCustomFields(value: string): JsonObject {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("Custom fields must be valid JSON.");
	}
	if (!isJsonObject(parsed)) {
		throw new Error("Custom fields must be a JSON object.");
	}
	return parsed;
}

export const registerCreateKeyCommand = (
	program: Command,
	getService: () => AdminOperations,
): void => {
	program
		.command("create-key")
		.description("Create a license key for an existing user")
		.requiredOption(
			"-u, --user-id <id>",
			"User ID from create-user or list-users",
		)
		.option(
			"-t, --type <type>",
			"PERPETUAL, SUBSCRIPTION, or USAGE",
			parseKeyType,
			"PERPETUAL",
		)
		.option(
			"--limit-ip <number>",
			"Allowed IP count; 0 is unlimited",
			parseNonNegativeInteger,
			0,
		)
		.option(
			"--limit-hwid <number>",
			"Allowed device count; 0 is unlimited",
			parseNonNegativeInteger,
			0,
		)
		.option(
			"--limit-concurrent <number>",
			"Concurrent sessions; 0 is unlimited",
			parseNonNegativeInteger,
			0,
		)
		.option(
			"--limit-usage <number>",
			"Usage count for USAGE keys",
			parseNonNegativeInteger,
			0,
		)
		.option(
			"--trial-duration-min <number>",
			"Trial duration in minutes",
			parseNonNegativeInteger,
			0,
		)
		.option(
			"--custom-fields <json>",
			"JSON object returned to the licensed application",
			parseCustomFields,
		)
		.option(
			"--expires-at <iso-date>",
			"Subscription expiration as an ISO date",
			parseIsoDate,
		)
		.action(async (options: CreateKeyOptions) => {
			try {
				const result = await getService().createKey(options);
				console.log(JSON.stringify(result, null, 2));
			} catch (error) {
				reportCommandError("Failed to create key", error);
			}
		});
};
