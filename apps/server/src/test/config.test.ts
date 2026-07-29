import { describe, expect, test } from "bun:test";
import { loadServerConfig } from "../config";

const validEnvironment = {
	DATABASE_URL: "postgresql://localhost/keyzori",
	REDIS_URL: "redis://localhost:6379",
	ADMIN_API_KEY: "a-secure-production-key-that-is-long-enough",
	TRUSTED_PROXY_HEADER: "x-forwarded-for",
};

describe("loadServerConfig", () => {
	test("loads secure defaults", () => {
		expect(loadServerConfig(validEnvironment)).toMatchObject({
			host: "0.0.0.0",
			port: 3000,
			trustProxyHeaders: false,
			trustedProxyHeader: "x-forwarded-for",
			openapiEnabled: true,
			rateLimitPerMinute: 60,
			licenseRateLimitPerMinute: 30,
			rateLimitPerIpPerMinute: 6_000,
			maxRequestBodyBytes: 65_536,
			trustedProxyCidrs: [],
		});
	});

	test("requires valid immediate proxy networks when headers are trusted", () => {
		expect(
			loadServerConfig({
				...validEnvironment,
				TRUSTED_PROXY_HEADER: "cf-connecting-ip",
			}).trustedProxyHeader,
		).toBe("cf-connecting-ip");
		expect(() =>
			loadServerConfig({
				...validEnvironment,
				TRUST_PROXY_HEADERS: "true",
			}),
		).toThrow("TRUSTED_PROXY_CIDRS must list");
		expect(
			loadServerConfig({
				...validEnvironment,
				TRUST_PROXY_HEADERS: "true",
				TRUSTED_PROXY_CIDRS: "10.0.0.0/8,2001:db8::/32",
			}).trustedProxyCidrs,
		).toEqual(["10.0.0.0/8", "2001:db8::/32"]);
		expect(() =>
			loadServerConfig({
				...validEnvironment,
				TRUST_PROXY_HEADERS: "true",
				TRUSTED_PROXY_CIDRS: "not-a-network",
			}),
		).toThrow("IPv4 or IPv6 CIDR");
		expect(() =>
			loadServerConfig({
				...validEnvironment,
				TRUSTED_PROXY_HEADER: "forwarded",
			}),
		).toThrow("TRUSTED_PROXY_HEADER must be either");
	});

	test("rejects short and placeholder admin secrets", () => {
		expect(() =>
			loadServerConfig({ ...validEnvironment, ADMIN_API_KEY: "short" }),
		).toThrow("at least 32 characters");
		expect(() =>
			loadServerConfig({
				...validEnvironment,
				ADMIN_API_KEY: "replace_with_a_long_random_secret",
			}),
		).toThrow("at least 32 characters");
		expect(() =>
			loadServerConfig({
				...validEnvironment,
				ADMIN_API_KEYS: "another-valid-admin-key-that-is-long-enough,short",
			}),
		).toThrow("at least 32 characters");
	});

	test("rejects invalid typed settings", () => {
		expect(() =>
			loadServerConfig({ ...validEnvironment, PORT: "70000" }),
		).toThrow("PORT must be an integer");
		expect(() =>
			loadServerConfig({ ...validEnvironment, OPENAPI_ENABLED: "yes" }),
		).toThrow("OPENAPI_ENABLED must be either true or false");
	});

	test("rejects malformed or unsupported dependency URLs", () => {
		expect(() =>
			loadServerConfig({ ...validEnvironment, DATABASE_URL: "not-a-url" }),
		).toThrow("DATABASE_URL must be a valid URL");
		expect(() =>
			loadServerConfig({
				...validEnvironment,
				REDIS_URL: "https://redis.test",
			}),
		).toThrow("REDIS_URL must use redis or rediss");
	});
});
