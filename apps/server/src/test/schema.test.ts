import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
	apiKeys,
	hwidWhitelists,
	ipWhitelists,
	keyDeviceMappings,
	keyType,
	registeredDevices,
	users,
} from "../db/schema";

describe("database schema", () => {
	test("defines the supported key types and core table names", () => {
		expect(keyType.enumValues).toEqual(["PERPETUAL", "SUBSCRIPTION", "USAGE"]);
		expect(
			[users, apiKeys, ipWhitelists, hwidWhitelists, registeredDevices].map(
				(table) => getTableConfig(table).name,
			),
		).toEqual([
			"User",
			"ApiKey",
			"IpWhitelist",
			"HwidWhitelist",
			"RegisteredDevice",
		]);
	});

	test("materializes all uniqueness and foreign-key constraints", () => {
		const apiKeyConfig = getTableConfig(apiKeys);
		const ipConfig = getTableConfig(ipWhitelists);
		const hwidConfig = getTableConfig(hwidWhitelists);
		const deviceConfig = getTableConfig(registeredDevices);
		const mappingConfig = getTableConfig(keyDeviceMappings);

		expect(apiKeyConfig.foreignKeys.map((key) => key.getName())).toEqual([
			"ApiKey_userId_fkey",
		]);
		expect(apiKeyConfig.checks.map((check) => check.name)).toEqual([
			"ApiKey_limitIp_nonnegative",
			"ApiKey_limitHwid_nonnegative",
			"ApiKey_limitConcurrent_nonnegative",
			"ApiKey_limitUsage_nonnegative",
			"ApiKey_trialDurationMin_nonnegative",
		]);
		expect(ipConfig.indexes.map((index) => index.config.name)).toEqual([
			"IpWhitelist_apiKeyId_ip_key",
		]);
		expect(hwidConfig.indexes.map((index) => index.config.name)).toEqual([
			"HwidWhitelist_apiKeyId_hwid_key",
		]);
		expect(deviceConfig.indexes.map((index) => index.config.name)).toEqual([
			"RegisteredDevice_ip_hwid_key",
		]);
		expect(mappingConfig.indexes.map((index) => index.config.name)).toEqual([
			"KeyDeviceMapping_apiKeyId_registeredDeviceId_key",
		]);
		expect(mappingConfig.foreignKeys.map((key) => key.getName())).toEqual([
			"KeyDeviceMapping_apiKeyId_fkey",
			"KeyDeviceMapping_registeredDeviceId_fkey",
		]);
	});
});
