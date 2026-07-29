import { isIP } from "node:net";
import type { TrustedProxyHeader } from "./controllers/clientIp";

export interface ServerConfig {
	databaseUrl: string;
	redisUrl: string;
	adminApiKey: string;
	additionalAdminApiKeys: string[];
	host: string;
	port: number;
	trustProxyHeaders: boolean;
	trustedProxyCidrs: string[];
	trustedProxyHeader: TrustedProxyHeader;
	openapiEnabled: boolean;
	rateLimitPerMinute: number;
	licenseRateLimitPerMinute: number;
	rateLimitPerIpPerMinute: number;
	maxRequestBodyBytes: number;
}

function trustedProxyCidrs(
	environment: Record<string, string | undefined>,
	enabled: boolean,
): string[] {
	const values = (environment.TRUSTED_PROXY_CIDRS ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (enabled && values.length === 0) {
		throw new Error(
			"TRUSTED_PROXY_CIDRS must list the immediate proxy networks when TRUST_PROXY_HEADERS is true.",
		);
	}
	for (const value of values) {
		const [address, prefixText, extra] = value.split("/");
		const family = address ? isIP(address) : 0;
		const maximum = family === 4 ? 32 : 128;
		const prefix = Number(prefixText);
		if (
			extra !== undefined ||
			family === 0 ||
			!Number.isInteger(prefix) ||
			prefix < 0 ||
			prefix > maximum
		) {
			throw new Error(
				"TRUSTED_PROXY_CIDRS must contain comma-separated IPv4 or IPv6 CIDR ranges.",
			);
		}
	}
	return values;
}

function required(
	environment: Record<string, string | undefined>,
	name: string,
): string {
	const value = environment[name]?.trim();
	if (!value) throw new Error(`${name} must be configured.`);
	return value;
}

function serviceUrl(
	environment: Record<string, string | undefined>,
	name: "DATABASE_URL" | "REDIS_URL",
	protocols: readonly string[],
): string {
	const value = required(environment, name);
	let protocol: string;
	try {
		protocol = new URL(value).protocol;
	} catch {
		throw new Error(`${name} must be a valid URL.`);
	}
	if (!protocols.includes(protocol)) {
		throw new Error(
			`${name} must use ${protocols.map((entry) => entry.replace(":", "")).join(" or ")}.`,
		);
	}
	return value;
}

function booleanValue(
	environment: Record<string, string | undefined>,
	name: string,
	fallback: boolean,
): boolean {
	const value = environment[name];
	if (value === undefined || value === "") return fallback;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`${name} must be either true or false.`);
}

function integerValue(
	environment: Record<string, string | undefined>,
	name: string,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	const raw = environment[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error(
			`${name} must be an integer between ${minimum} and ${maximum}.`,
		);
	}
	return value;
}

function parseTrustedProxyHeaderMode(
	environment: Record<string, string | undefined>,
): TrustedProxyHeader {
	const value = environment.TRUSTED_PROXY_HEADER?.trim() || "x-forwarded-for";
	if (value !== "x-forwarded-for" && value !== "cf-connecting-ip") {
		throw new Error(
			"TRUSTED_PROXY_HEADER must be either x-forwarded-for or cf-connecting-ip.",
		);
	}
	return value;
}

export function loadServerConfig(
	environment: Record<string, string | undefined> = Bun.env,
): ServerConfig {
	const adminApiKey = required(environment, "ADMIN_API_KEY");
	const additionalAdminApiKeys = (environment.ADMIN_API_KEYS ?? "")
		.split(",")
		.map((key) => key.trim())
		.filter(Boolean);
	const trustProxyHeaders = booleanValue(
		environment,
		"TRUST_PROXY_HEADERS",
		false,
	);
	for (const key of [adminApiKey, ...additionalAdminApiKeys]) {
		if (
			key.length < 32 ||
			/^(replace|change|your[_-]?secure|example|development)/i.test(key)
		) {
			throw new Error(
				"Admin API keys must be non-placeholder secrets of at least 32 characters.",
			);
		}
	}

	return {
		databaseUrl: serviceUrl(environment, "DATABASE_URL", [
			"postgres:",
			"postgresql:",
		]),
		redisUrl: serviceUrl(environment, "REDIS_URL", ["redis:", "rediss:"]),
		adminApiKey,
		additionalAdminApiKeys,
		host: environment.HOST?.trim() || "0.0.0.0",
		port: integerValue(environment, "PORT", 3000, 1, 65_535),
		trustProxyHeaders,
		trustedProxyCidrs: trustedProxyCidrs(environment, trustProxyHeaders),
		trustedProxyHeader: parseTrustedProxyHeaderMode(environment),
		openapiEnabled: booleanValue(environment, "OPENAPI_ENABLED", true),
		rateLimitPerMinute: integerValue(
			environment,
			"RATE_LIMIT_PER_MINUTE",
			60,
			1,
			100_000,
		),
		licenseRateLimitPerMinute: integerValue(
			environment,
			"LICENSE_RATE_LIMIT_PER_MINUTE",
			30,
			1,
			100_000,
		),
		rateLimitPerIpPerMinute: integerValue(
			environment,
			"RATE_LIMIT_PER_IP_PER_MINUTE",
			6_000,
			1,
			1_000_000,
		),
		maxRequestBodyBytes: integerValue(
			environment,
			"MAX_REQUEST_BODY_BYTES",
			65_536,
			1_024,
			10_485_760,
		),
	};
}
