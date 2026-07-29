import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	foreignKey,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import type { JsonObject } from "../domain/entities";

export const keyType = pgEnum("KeyType", [
	"PERPETUAL",
	"SUBSCRIPTION",
	"USAGE",
]);

export const users = pgTable("User", {
	id: text().primaryKey(),
	email: text().notNull().unique(),
	name: text().notNull(),
	customFields: jsonb().$type<JsonObject>().notNull().default({}),
	createdAt: timestamp({ mode: "date", precision: 3 }).notNull().defaultNow(),
});

export const apiKeys = pgTable(
	"ApiKey",
	{
		id: text().primaryKey(),
		keyHash: text().notNull().unique(),
		keyPrefix: text().notNull(),
		userId: text().notNull(),
		type: keyType().notNull().default("PERPETUAL"),
		limitIp: integer().notNull().default(0),
		limitHwid: integer().notNull().default(0),
		limitConcurrent: integer().notNull().default(0),
		limitUsage: integer().notNull().default(0),
		trialDurationMin: integer().notNull().default(0),
		firstActivatedAt: timestamp({ mode: "date", precision: 3 }),
		customFields: jsonb().$type<JsonObject>().notNull().default({}),
		expiresAt: timestamp({ mode: "date", precision: 3 }),
		revoked: boolean().notNull().default(false),
		createdAt: timestamp({ mode: "date", precision: 3 }).notNull().defaultNow(),
	},
	(table) => [
		check("ApiKey_limitIp_nonnegative", sql`${table.limitIp} >= 0`),
		check("ApiKey_limitHwid_nonnegative", sql`${table.limitHwid} >= 0`),
		check(
			"ApiKey_limitConcurrent_nonnegative",
			sql`${table.limitConcurrent} >= 0`,
		),
		check("ApiKey_limitUsage_nonnegative", sql`${table.limitUsage} >= 0`),
		check(
			"ApiKey_trialDurationMin_nonnegative",
			sql`${table.trialDurationMin} >= 0`,
		),
		foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "ApiKey_userId_fkey",
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

export const ipWhitelists = pgTable(
	"IpWhitelist",
	{
		id: text().primaryKey(),
		apiKeyId: text().notNull(),
		ip: text().notNull(),
		createdAt: timestamp({ mode: "date", precision: 3 }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("IpWhitelist_apiKeyId_ip_key").on(table.apiKeyId, table.ip),
		foreignKey({
			columns: [table.apiKeyId],
			foreignColumns: [apiKeys.id],
			name: "IpWhitelist_apiKeyId_fkey",
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

export const hwidWhitelists = pgTable(
	"HwidWhitelist",
	{
		id: text().primaryKey(),
		apiKeyId: text().notNull(),
		hwid: text().notNull(),
		createdAt: timestamp({ mode: "date", precision: 3 }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("HwidWhitelist_apiKeyId_hwid_key").on(
			table.apiKeyId,
			table.hwid,
		),
		foreignKey({
			columns: [table.apiKeyId],
			foreignColumns: [apiKeys.id],
			name: "HwidWhitelist_apiKeyId_fkey",
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

export const registeredDevices = pgTable(
	"RegisteredDevice",
	{
		id: text().primaryKey(),
		ip: text().notNull(),
		hwid: text().notNull(),
		createdAt: timestamp({ mode: "date", precision: 3 }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("RegisteredDevice_ip_hwid_key").on(table.ip, table.hwid),
	],
);

export const keyDeviceMappings = pgTable(
	"KeyDeviceMapping",
	{
		id: text().primaryKey(),
		apiKeyId: text().notNull(),
		registeredDeviceId: text().notNull(),
		createdAt: timestamp({ mode: "date", precision: 3 }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("KeyDeviceMapping_apiKeyId_registeredDeviceId_key").on(
			table.apiKeyId,
			table.registeredDeviceId,
		),
		foreignKey({
			columns: [table.apiKeyId],
			foreignColumns: [apiKeys.id],
			name: "KeyDeviceMapping_apiKeyId_fkey",
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			columns: [table.registeredDeviceId],
			foreignColumns: [registeredDevices.id],
			name: "KeyDeviceMapping_registeredDeviceId_fkey",
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);
