import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { RedisClient, SQL } from "bun";
import { LicenseClient } from "../apps/sdk/src/core/LicenseClient";
import { LicenseRequestError } from "../apps/sdk/src/core/LicenseRequestError";
import { hashUsageEventId } from "../apps/server/src/domain/usageEvent";

const liveEnabled = Bun.env.KEYZORI_LIVE_TEST_ENABLED === "true";
if (!liveEnabled) {
	console.warn(
		"SKIP live flow: set KEYZORI_LIVE_TEST_ENABLED=true with PostgreSQL and Redis URLs.",
	);
	process.exit(0);
}

for (const name of [
	"KEYZORI_DATABASE_URL",
	"KEYZORI_REDIS_URL",
	"KEYZORI_ADMIN_API_KEY",
] as const) {
	const value = Bun.env[name];
	if (
		!value ||
		value.includes("your_secure_") ||
		value.includes("replace_with_")
	) {
		console.warn(`SKIP live flow: ${name} is unavailable or a placeholder.`);
		process.exit(0);
	}
}

const serverDirectory = resolve(import.meta.dir, "../apps/server");
const migrationsDirectory = resolve(serverDirectory, "drizzle");
const keyzoriBinary = resolve(
	serverDirectory,
	"dist",
	process.platform === "win32" ? "keyzori.exe" : "keyzori",
);
if (!existsSync(keyzoriBinary)) {
	throw new Error("Build the unified keyzori executable before the live flow.");
}

const baseDatabaseUrl = new URL(Bun.env.KEYZORI_DATABASE_URL as string);
const maintenanceUrl = new URL(baseDatabaseUrl);
maintenanceUrl.pathname = "/postgres";
const databaseName = `keyzori_live_${crypto.randomUUID().replaceAll("-", "")}`;
const testDatabaseUrl = new URL(baseDatabaseUrl);
testDatabaseUrl.pathname = `/${databaseName}`;
const maintenance = new SQL(maintenanceUrl.toString());
const redis = new RedisClient(Bun.env.KEYZORI_REDIS_URL as string);
let database: SQL | undefined;
let server: ReturnType<typeof Bun.spawn> | undefined;
let createdDatabase = false;
const createdLicenseIds = new Set<string>();
const port = 32_000 + Math.floor(Math.random() * 4_000);
const serverUrl = `http://127.0.0.1:${port}`;
const serverStartupTimeoutMs = 60_000;
const adminKey = Bun.env.KEYZORI_ADMIN_API_KEY as string;
const runtimeEnvironment = {
	...Bun.env,
	KEYZORI_DATABASE_URL: testDatabaseUrl.toString(),
	KEYZORI_REDIS_URL: Bun.env.KEYZORI_REDIS_URL as string,
	KEYZORI_ADMIN_API_KEY: adminKey,
	KEYZORI_SERVER_HOST: "127.0.0.1",
	KEYZORI_SERVER_PORT: String(port),
	KEYZORI_OPENAPI_ENABLED: "true",
	KEYZORI_RATE_LIMIT_PER_MINUTE: "100000",
	KEYZORI_LICENSE_RATE_LIMIT_PER_MINUTE: "100000",
	KEYZORI_RATE_LIMIT_PER_IP_PER_MINUTE: "100000",
};

interface CreatedRecord {
	id: string;
	licenseKey?: string;
}

interface StartupDatabaseActivity {
	pid: number;
	state: string | null;
	waitEventType: string | null;
	waitEvent: string | null;
	blockingPids: string;
	query: string;
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function migrationMillis(name: string): number {
	const value = name.slice(0, 14);
	return Date.UTC(
		Number(value.slice(0, 4)),
		Number(value.slice(4, 6)) - 1,
		Number(value.slice(6, 8)),
		Number(value.slice(8, 10)),
		Number(value.slice(10, 12)),
		Number(value.slice(12, 14)),
	);
}

async function applyPreOverhaulMigrations(sql: SQL): Promise<void> {
	const migrationNames = readdirSync(migrationsDirectory)
		.filter((name) => name < "20260815063723_licensing_overhaul")
		.sort();
	assert(migrationNames.length > 0, "Pre-overhaul migrations were not found.");
	for (const name of migrationNames) {
		const contents = readFileSync(
			resolve(migrationsDirectory, name, "migration.sql"),
			"utf8",
		);
		for (const statement of contents.split("--> statement-breakpoint")) {
			if (statement.trim()) await sql.unsafe(statement);
		}
	}

	await sql.unsafe('CREATE SCHEMA IF NOT EXISTS "drizzle"');
	await sql.unsafe(`
		CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
			"id" SERIAL PRIMARY KEY,
			"hash" text NOT NULL,
			"created_at" bigint,
			"name" text,
			"applied_at" timestamp with time zone DEFAULT now()
		)
	`);
	for (const name of migrationNames) {
		const contents = readFileSync(
			resolve(migrationsDirectory, name, "migration.sql"),
			"utf8",
		);
		await sql`
			INSERT INTO "drizzle"."__drizzle_migrations"
				("hash", "created_at", "name")
			VALUES (
				${createHash("sha256").update(contents).digest("hex")},
				${migrationMillis(name)},
				${name}
			)
		`;
	}
}

async function seedLegacyData(sql: SQL): Promise<Record<string, string>> {
	const customerId = "legacy-customer";
	await sql`
		INSERT INTO "User" ("id", "email", "name", "customFields")
		VALUES (
			${customerId},
			'legacy@example.invalid',
			'Legacy Customer',
			jsonb_build_object('imported', true)
		)
	`;

	const secrets = {
		lifetime: "sk_legacy_lifetime_secret",
		subscription: "sk_legacy_subscription_secret",
		metered: "sk_legacy_metered_secret",
		trialLifetime: "sk_legacy_trial_lifetime_secret",
		trialSubscription: "sk_legacy_trial_subscription_secret",
		trialMetered: "sk_legacy_trial_metered_secret",
	};
	const future = new Date(Date.now() + 24 * 60 * 60_000);
	const trialStartedAt = new Date(Date.now() - 30 * 60_000);
	const rows = [
		["legacy-lifetime", secrets.lifetime, "PERPETUAL", 5, 0, null, null],
		[
			"legacy-subscription",
			secrets.subscription,
			"SUBSCRIPTION",
			6,
			0,
			null,
			future,
		],
		["legacy-metered", secrets.metered, "USAGE", 11, 0, null, null],
		[
			"legacy-trial-lifetime",
			secrets.trialLifetime,
			"PERPETUAL",
			0,
			60,
			trialStartedAt,
			null,
		],
		[
			"legacy-trial-subscription",
			secrets.trialSubscription,
			"SUBSCRIPTION",
			0,
			90,
			trialStartedAt,
			future,
		],
		[
			"legacy-trial-metered",
			secrets.trialMetered,
			"USAGE",
			7,
			120,
			trialStartedAt,
			null,
		],
	] as const;
	for (const [
		id,
		secret,
		type,
		usage,
		trialMinutes,
		startedAt,
		expiresAt,
	] of rows) {
		await sql`
			INSERT INTO "ApiKey" (
				"id", "keyHash", "keyPrefix", "userId", "type",
				"limitIp", "limitHwid", "limitConcurrent", "limitUsage",
				"trialDurationMin", "firstActivatedAt", "customFields",
				"expiresAt", "revoked"
			)
			VALUES (
				${id},
				${createHash("sha256").update(secret).digest("hex")},
				${secret.slice(0, 12)},
				${customerId},
				${type}::"KeyType",
				2, 2, 2, ${usage}, ${trialMinutes}, ${startedAt},
				jsonb_build_object('legacyType', ${type}::text), ${expiresAt}, false
			)
		`;
	}

	await sql`
		INSERT INTO "IpWhitelist" ("id", "apiKeyId", "ip")
		VALUES
			('legacy-ip-allow', 'legacy-metered', '203.0.113.10'),
			('legacy-ipv6-expanded', 'legacy-metered', '2001:0db8::1'),
			('legacy-ipv6-canonical', 'legacy-metered', '2001:db8::1')
	`;
	await sql`
		INSERT INTO "HwidWhitelist" ("id", "apiKeyId", "hwid")
		VALUES ('legacy-device-allow', 'legacy-metered', 'legacy-device')
	`;
	await sql`
		INSERT INTO "RegisteredDevice" ("id", "ip", "hwid")
		VALUES
			('legacy-device-row', '203.0.113.10', 'legacy-device'),
			('legacy-ipv6-device-expanded', '2001:0db8::2', 'ipv6-device'),
			('legacy-ipv6-device-canonical', '2001:db8::2', 'ipv6-device')
	`;
	await sql`
		INSERT INTO "KeyDeviceMapping" (
			"id", "apiKeyId", "registeredDeviceId"
		)
		VALUES
			('legacy-mapping', 'legacy-metered', 'legacy-device-row'),
			('legacy-ipv6-mapping-expanded', 'legacy-metered', 'legacy-ipv6-device-expanded'),
			('legacy-ipv6-mapping-canonical', 'legacy-metered', 'legacy-ipv6-device-canonical')
	`;
	await sql`
		INSERT INTO "AccessAttempt" (
			"id", "apiKeyId", "ip", "hwid", "attemptCount"
		)
		VALUES (
			'legacy-attempt-row', 'legacy-metered',
			'198.51.100.9', 'attempted-device', 4
		)
	`;
	return secrets;
}

async function collectStartupDatabaseActivity(): Promise<string> {
	const diagnosticDatabase = new SQL(testDatabaseUrl.toString());
	try {
		const activity = await diagnosticDatabase<StartupDatabaseActivity[]>`
			SELECT
				"pid",
				"state",
				"wait_event_type" AS "waitEventType",
				"wait_event" AS "waitEvent",
				pg_blocking_pids("pid")::text AS "blockingPids",
				left("query", 500) AS "query"
			FROM pg_stat_activity
			WHERE "datname" = ${databaseName}
				AND "pid" <> pg_backend_pid()
			ORDER BY "pid"
		`;
		return activity.length > 0
			? JSON.stringify(activity, null, 2)
			: "No PostgreSQL sessions were active for the live-test database.";
	} catch (error) {
		return `PostgreSQL startup diagnostics unavailable: ${String(error)}`;
	} finally {
		await diagnosticDatabase.close({ timeout: 1 }).catch(() => undefined);
	}
}

async function waitForServer(): Promise<void> {
	if (!server) throw new Error("Server process was not started.");
	const deadline = Date.now() + serverStartupTimeoutMs;
	while (Date.now() < deadline) {
		if (server.exitCode !== null) {
			throw new Error(
				`Server exited during startup with code ${server.exitCode}.`,
			);
		}
		try {
			const response = await fetch(`${serverUrl}/ready`, {
				signal: AbortSignal.timeout(
					Math.min(1_000, Math.max(1, deadline - Date.now())),
				),
			});
			if (response.ok) return;
		} catch {
			// Migrations and dependency connections may still be in progress.
		}
		const remaining = deadline - Date.now();
		if (remaining > 0) await Bun.sleep(Math.min(250, remaining));
	}
	const activity = await collectStartupDatabaseActivity();
	throw new Error(
		`Server did not become ready within ${serverStartupTimeoutMs / 1_000} seconds.\nPostgreSQL activity:\n${activity}`,
	);
}

async function runCli(arguments_: string[]): Promise<string> {
	const process = Bun.spawn([keyzoriBinary, "admin", ...arguments_], {
		cwd: serverDirectory,
		env: runtimeEnvironment,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(stderr.trim() || `CLI exited with code ${exitCode}.`);
	}
	return stdout.trim();
}

function parseCreatedRecord(output: string): CreatedRecord {
	const value: unknown = JSON.parse(output);
	assert(
		value !== null &&
			typeof value === "object" &&
			"id" in value &&
			typeof value.id === "string",
		"CLI returned an invalid created record.",
	);
	const record = value as Record<string, unknown>;
	return {
		id: record.id as string,
		...(typeof record.licenseKey === "string"
			? { licenseKey: record.licenseKey }
			: {}),
	};
}

async function post(path: string, body: object): Promise<Response> {
	return await fetch(`${serverUrl}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function expectClientCode(
	promise: Promise<unknown>,
	code: string,
): Promise<void> {
	try {
		await promise;
		throw new Error(`Expected SDK rejection ${code}.`);
	} catch (error) {
		assert(
			error instanceof LicenseRequestError && error.code === code,
			`Expected SDK rejection ${code}, received ${String(error)}.`,
		);
	}
}

async function verifyMigration(
	sql: SQL,
	legacySecrets: Record<string, string>,
): Promise<void> {
	const rows = await sql<
		{
			id: string;
			type: string;
			typeDrafts: Record<string, unknown>;
			trialDurationMinutes: number;
			trialStartedAt: Date | null;
			keyPrefix: string;
		}[]
	>`
		SELECT
			"id", "type", "type_drafts" AS "typeDrafts",
			"trial_duration_minutes" AS "trialDurationMinutes",
			"trial_started_at" AS "trialStartedAt", "key_prefix" AS "keyPrefix"
		FROM "licenses"
		WHERE "id" LIKE 'legacy-%'
	`;
	const byId = new Map(rows.map((row) => [row.id, row]));
	assert(
		byId.get("legacy-lifetime")?.type === "lifetime",
		"Lifetime migration failed.",
	);
	assert(
		byId.get("legacy-subscription")?.type === "subscription",
		"Subscription migration failed.",
	);
	assert(
		byId.get("legacy-metered")?.type === "metered",
		"Metered migration failed.",
	);
	for (const id of [
		"legacy-trial-lifetime",
		"legacy-trial-subscription",
		"legacy-trial-metered",
	]) {
		const row = byId.get(id);
		assert(row?.type === "trial", `${id} was not converted to a trial.`);
		assert(row.trialStartedAt instanceof Date, `${id} lost its trial start.`);
		assert(row.trialDurationMinutes > 0, `${id} lost its trial duration.`);
	}
	assert(
		"lifetime" in (byId.get("legacy-trial-lifetime")?.typeDrafts ?? {}),
		"The mixed lifetime trial lost its conversion draft.",
	);
	assert(
		"subscription" in (byId.get("legacy-trial-subscription")?.typeDrafts ?? {}),
		"The mixed subscription trial lost its conversion draft.",
	);
	assert(
		"metered" in (byId.get("legacy-trial-metered")?.typeDrafts ?? {}),
		"The mixed metered trial lost its conversion draft.",
	);
	assert(
		byId.get("legacy-lifetime")?.keyPrefix ===
			legacySecrets.lifetime?.slice(0, 12),
		"The existing sk_ key prefix changed.",
	);

	const meters = await sql<{ licenseId: string; balance: number }[]>`
		SELECT "license_id" AS "licenseId", "balance"
		FROM "license_meters" WHERE "name" = 'usage'
	`;
	const meterBalances = new Map(
		meters.map((meter) => [meter.licenseId, meter.balance]),
	);
	assert(
		meterBalances.get("legacy-metered") === 11,
		"Legacy usage balance was lost.",
	);
	assert(
		meterBalances.get("legacy-lifetime") === 5 &&
			meterBalances.get("legacy-subscription") === 6,
		"Dormant legacy usage balances were lost.",
	);
	assert(
		meterBalances.get("legacy-trial-metered") === 7,
		"Mixed-trial usage balance was lost.",
	);

	const access = await sql<
		{
			allowedIps: number;
			allowedDevices: number;
			registeredDevices: number;
			attemptTotal: number;
		}[]
	>`
		SELECT
			(SELECT count(*)::int FROM "license_ip_allowlist_entries"
				WHERE "license_id" = 'legacy-metered') AS "allowedIps",
			(SELECT count(*)::int FROM "license_device_allowlist_entries"
				WHERE "license_id" = 'legacy-metered') AS "allowedDevices",
			(SELECT count(*)::int FROM "registered_devices"
				WHERE "license_id" = 'legacy-metered') AS "registeredDevices",
			(SELECT "count"::int FROM "activity_totals"
				WHERE "scope" = 'license' AND "scope_id" = 'legacy-metered'
				AND "type" = 'license.activation_attempted') AS "attemptTotal"
	`;
	assert(
		access[0]?.allowedIps === 2 &&
			access[0].allowedDevices === 1 &&
			access[0].registeredDevices === 2 &&
			access[0].attemptTotal === 4,
		"Legacy access and attempt records were not preserved.",
	);

	const legacyClient = new LicenseClient({
		licenseKey: legacySecrets.lifetime as string,
		serverUrl,
		deviceId: "legacy-key-proof",
	});
	let legacyActivation: Awaited<ReturnType<LicenseClient["activate"]>>;
	try {
		legacyActivation = await legacyClient.activate();
	} catch (error) {
		const diagnostics = await sql<
			{ attempts: number; registrations: number }[]
		>`
			SELECT
				(SELECT count(*)::int FROM "activity_events"
					WHERE "license_id" = 'legacy-lifetime'
						AND "type" = 'license.activation_attempted') AS "attempts",
				(SELECT count(*)::int FROM "registered_devices"
					WHERE "license_id" = 'legacy-lifetime') AS "registrations"
		`;
		throw new Error(
			`Migrated secret activation failed after ${diagnostics[0]?.attempts ?? 0} service attempts and ${diagnostics[0]?.registrations ?? 0} registrations.`,
			{ cause: error },
		);
	}
	assert(
		legacyActivation.licenseType === "lifetime",
		"An existing sk_ secret hash no longer activates.",
	);
	await legacyClient.deactivate();
	console.log("Data-preserving upgrade migration passed.");
}

async function verifyCanonicalFlow(sql: SQL): Promise<void> {
	const runId = crypto.randomUUID();
	const customer = parseCreatedRecord(
		await runCli([
			"customers",
			"create",
			"--email",
			`live-${runId}@example.invalid`,
			"--name",
			"Live Test",
		]),
	);
	const future = new Date(Date.now() + 60 * 60_000).toISOString();
	const lifetime = parseCreatedRecord(
		await runCli([
			"licenses",
			"create",
			"--customer-id",
			customer.id,
			"--type",
			"lifetime",
			"--max-ips",
			"1",
			"--max-devices",
			"1",
			"--metadata",
			JSON.stringify({ flow: runId }),
		]),
	);
	const subscription = parseCreatedRecord(
		await runCli([
			"licenses",
			"create",
			"--customer-id",
			customer.id,
			"--type",
			"subscription",
			"--expires-at",
			future,
		]),
	);
	const metered = parseCreatedRecord(
		await runCli([
			"licenses",
			"create",
			"--customer-id",
			customer.id,
			"--type",
			"metered",
			"--meter",
			"credits=10",
			"--meter-reason",
			"Initial live allocation",
		]),
	);
	const trial = parseCreatedRecord(
		await runCli([
			"licenses",
			"create",
			"--customer-id",
			customer.id,
			"--type",
			"trial",
			"--trial-duration-minutes",
			"30",
		]),
	);
	for (const record of [lifetime, subscription, metered, trial]) {
		createdLicenseIds.add(record.id);
		assert(
			record.licenseKey?.startsWith("lic_"),
			"CLI did not reveal a new lic_ key.",
		);
	}

	for (const [record, type] of [
		[lifetime, "lifetime"],
		[subscription, "subscription"],
		[trial, "trial"],
	] as const) {
		const client = new LicenseClient({
			licenseKey: record.licenseKey as string,
			serverUrl,
			deviceId: `${type}-${runId}`,
		});
		assert(
			(await client.activate()).licenseType === type,
			`${type} activation failed.`,
		);
		await client.deactivate();
	}
	const trialRows = await sql<{ startedAt: Date | null }[]>`
		SELECT "trial_started_at" AS "startedAt"
		FROM "licenses" WHERE "id" = ${trial.id}
	`;
	assert(
		trialRows[0]?.startedAt instanceof Date,
		"Trial did not start on activation.",
	);
	await sql`
		UPDATE "licenses"
		SET "trial_started_at" = ${new Date(Date.now() - 31 * 60_000)}
		WHERE "id" = ${trial.id}
	`;
	await expectClientCode(
		new LicenseClient({
			licenseKey: trial.licenseKey as string,
			serverUrl,
			deviceId: `expired-trial-${runId}`,
		}).activate(),
		"LICENSE_EXPIRED",
	);

	const meteredClient = new LicenseClient({
		licenseKey: metered.licenseKey as string,
		serverUrl,
		deviceId: `metered-${runId}`,
	});
	assert(
		(await meteredClient.activate()).licenseType === "metered",
		"Metered activation failed.",
	);
	const firstUsage = await meteredClient.consume({
		meter: "credits",
		units: 4,
		eventId: `usage-${runId}`,
	});
	const replay = await meteredClient.consume({
		meter: "credits",
		units: 4,
		eventId: `usage-${runId}`,
	});
	assert(
		firstUsage.remaining === 6 && replay.remaining === 6,
		"Idempotent meter retry changed the balance.",
	);
	await expectClientCode(
		meteredClient.consume({
			meter: "credits",
			units: 1,
			eventId: `usage-${runId}`,
		}),
		"USAGE_EVENT_CONFLICT",
	);
	await expectClientCode(
		meteredClient.consume({
			meter: "credits",
			units: 7,
			eventId: `overdraw-${runId}`,
		}),
		"METER_EXHAUSTED",
	);
	await meteredClient.deactivate();
	const ledgerRows = await sql<{ count: number }[]>`
		SELECT count(*)::int AS "count" FROM "usage_ledger_entries"
		WHERE "license_id" = ${metered.id} AND "event_id" = ${hashUsageEventId(`usage-${runId}`)}
	`;
	assert(
		ledgerRows[0]?.count === 1,
		"Usage retry inserted a duplicate ledger row.",
	);

	await runCli(["licenses", "access", "reset-registered-devices", lifetime.id]);
	const activation = await post("/v1/activate", {
		licenseKey: lifetime.licenseKey,
		deviceId: `direct-${runId}`,
	});
	assert(activation.ok, "Direct lifetime activation failed.");
	const activationBody = (await activation.json()) as { sessionToken?: string };
	assert(
		activationBody.sessionToken,
		"Activation did not return a session token.",
	);
	await runCli([
		"licenses",
		"update",
		lifetime.id,
		"--type",
		"subscription",
		"--expires-at",
		future,
	]);
	const heartbeat = await post("/v1/heartbeat", {
		sessionToken: activationBody.sessionToken,
		deviceId: `direct-${runId}`,
	});
	const heartbeatBody = (await heartbeat.json()) as { licenseType?: string };
	assert(
		heartbeat.ok && heartbeatBody.licenseType === "subscription",
		"Type switch did not apply to the next heartbeat.",
	);
	const replayedBinding = await post("/v1/heartbeat", {
		sessionToken: activationBody.sessionToken,
		deviceId: `stolen-${runId}`,
	});
	assert(
		replayedBinding.status === 403,
		"A session token escaped its device binding.",
	);
	await runCli(["licenses", "access", "reset-registered-devices", lifetime.id]);
	const afterReset = await post("/v1/heartbeat", {
		sessionToken: activationBody.sessionToken,
		deviceId: `direct-${runId}`,
	});
	assert(
		afterReset.status === 403,
		"Device reset did not terminate active sessions.",
	);

	await sql`
		UPDATE "licenses" SET "expires_at" = ${new Date(Date.now() - 60_000)}
		WHERE "id" = ${lifetime.id}
	`;
	const expiredClient = new LicenseClient({
		licenseKey: lifetime.licenseKey as string,
		serverUrl,
		deviceId: `expired-${runId}`,
	});
	await expectClientCode(expiredClient.activate(), "LICENSE_EXPIRED");
	await runCli(["licenses", "update", lifetime.id, "--type", "lifetime"]);

	const rotation = parseCreatedRecord(
		await runCli(["licenses", "rotate", lifetime.id]),
	);
	assert(
		rotation.licenseKey?.startsWith("lic_"),
		"Rotation did not reveal a new key.",
	);
	await expectClientCode(
		new LicenseClient({
			licenseKey: lifetime.licenseKey as string,
			serverUrl,
			deviceId: `old-key-${runId}`,
		}).activate(),
		"LICENSE_INVALID",
	);
	await runCli([
		"licenses",
		"revoke",
		lifetime.id,
		"--reason",
		"live flow check",
	]);
	await expectClientCode(
		new LicenseClient({
			licenseKey: rotation.licenseKey as string,
			serverUrl,
			deviceId: `revoked-${runId}`,
		}).activate(),
		"LICENSE_REVOKED",
	);
	await runCli(["licenses", "restore", lifetime.id]);
	const rotatedClient = new LicenseClient({
		licenseKey: rotation.licenseKey as string,
		serverUrl,
		deviceId: `new-key-${runId}`,
	});
	await rotatedClient.activate();
	await rotatedClient.deactivate();

	await runCli(["licenses", "access", "allow-ip", lifetime.id, "203.0.113.10"]);
	await expectClientCode(
		new LicenseClient({
			licenseKey: rotation.licenseKey as string,
			serverUrl,
			deviceId: `blocked-ip-${runId}`,
		}).activate(),
		"IP_NOT_ALLOWED",
	);
	await runCli([
		"licenses",
		"access",
		"remove-allowed-ip",
		lifetime.id,
		"203.0.113.10",
	]);
	const poolLicenses: CreatedRecord[] = [];
	for (let index = 0; index < 12; index++) {
		const record = parseCreatedRecord(
			await runCli([
				"licenses",
				"create",
				"--customer-id",
				customer.id,
				"--type",
				"lifetime",
			]),
		);
		createdLicenseIds.add(record.id);
		poolLicenses.push(record);
	}
	let poolTimeout: ReturnType<typeof setTimeout> | undefined;
	const poolBurst = await Promise.race([
		Promise.all(
			poolLicenses.map((record, index) =>
				post("/v1/activate", {
					licenseKey: record.licenseKey,
					deviceId: `pool-${index}-${runId}`,
				}),
			),
		),
		new Promise<never>((_, reject) => {
			poolTimeout = setTimeout(
				() => reject(new Error("Concurrent activation exceeded pool timeout.")),
				10_000,
			);
		}),
	]).finally(() => {
		if (poolTimeout) clearTimeout(poolTimeout);
	});
	assert(
		poolBurst.every((response) => response.ok),
		"Concurrent activation above the database pool size did not complete.",
	);

	const concurrent = parseCreatedRecord(
		await runCli([
			"licenses",
			"create",
			"--customer-id",
			customer.id,
			"--type",
			"lifetime",
			"--max-devices",
			"1",
		]),
	);
	createdLicenseIds.add(concurrent.id);
	const contenders = await Promise.all(
		["one", "two"].map(async (deviceId) => {
			const response = await post("/v1/activate", {
				licenseKey: concurrent.licenseKey,
				deviceId: `${deviceId}-${runId}`,
			});
			return response.status;
		}),
	);
	assert(
		contenders.filter((status) => status === 200).length === 1 &&
			contenders.filter((status) => status === 403).length === 1,
		"Concurrent device registration did not enforce maxDevices atomically.",
	);

	const sessionLimited = parseCreatedRecord(
		await runCli([
			"licenses",
			"create",
			"--customer-id",
			customer.id,
			"--type",
			"lifetime",
			"--max-sessions",
			"1",
		]),
	);
	createdLicenseIds.add(sessionLimited.id);
	const sessionContenders = await Promise.all(
		["one", "two"].map(async (deviceId) => {
			const response = await post("/v1/activate", {
				licenseKey: sessionLimited.licenseKey,
				deviceId: `session-${deviceId}-${runId}`,
			});
			return response.status;
		}),
	);
	assert(
		sessionContenders.filter((status) => status === 200).length === 1 &&
			sessionContenders.filter((status) => status === 403).length === 1,
		"Concurrent Redis session registration did not enforce maxSessions.",
	);

	const listOutput = await runCli(["licenses", "list"]);
	assert(
		!listOutput.includes(rotation.licenseKey as string) &&
			!listOutput.includes(metered.licenseKey as string),
		"License listing exposed a full secret.",
	);
	await runCli(["licenses", "delete", metered.id]);
	const deletedMeteredRows = await sql<
		{ licenses: number; meters: number; ledger: number }[]
	>`
		SELECT
			(SELECT count(*)::int FROM "licenses" WHERE "id" = ${metered.id}) AS "licenses",
			(SELECT count(*)::int FROM "license_meters" WHERE "license_id" = ${metered.id}) AS "meters",
			(SELECT count(*)::int FROM "usage_ledger_entries" WHERE "license_id" = ${metered.id}) AS "ledger"
	`;
	assert(
		deletedMeteredRows[0]?.licenses === 0 &&
			deletedMeteredRows[0]?.meters === 0 &&
			deletedMeteredRows[0]?.ledger === 0,
		"Deleting a metered license did not cascade through meters and ledger entries.",
	);
	console.log("Canonical PostgreSQL/Redis/CLI/HTTP/SDK flow passed.");
}

try {
	try {
		await maintenance.unsafe(`CREATE DATABASE "${databaseName}"`);
		createdDatabase = true;
	} catch (error) {
		console.warn(
			`SKIP live flow: cannot create isolated PostgreSQL database (${String(error)}).`,
		);
		process.exitCode = 0;
		process.exit(0);
	}
	await redis.connect();
	database = new SQL(testDatabaseUrl.toString());
	await database`SELECT 1`;
	await applyPreOverhaulMigrations(database);
	const legacySecrets = await seedLegacyData(database);
	await database.close({ timeout: 5 });
	database = undefined;

	server = Bun.spawn([keyzoriBinary, "serve"], {
		cwd: serverDirectory,
		env: runtimeEnvironment,
		stdout: "inherit",
		stderr: "inherit",
	});
	await waitForServer();
	database = new SQL(testDatabaseUrl.toString());
	await database`SELECT 1`;
	const openapiResponse = await fetch(`${serverUrl}/docs/openapi.json`);
	assert(openapiResponse.ok, "Canonical OpenAPI document was unavailable.");
	const openapiText = await openapiResponse.text();
	for (const path of [
		"/v1/activate",
		"/v1/heartbeat",
		"/v1/usage",
		"/v1/deactivate",
		"/admin/customers",
		"/admin/licenses",
	]) {
		assert(openapiText.includes(path), `OpenAPI is missing ${path}.`);
	}
	assert(
		!openapiText.includes("/v1/handshake"),
		"OpenAPI still publishes the legacy handshake route.",
	);

	await verifyMigration(database, legacySecrets);
	await verifyCanonicalFlow(database);
} finally {
	if (server && server.exitCode === null) {
		server.kill();
		await server.exited;
	}
	for (const licenseId of createdLicenseIds) {
		try {
			const tokens = await redis.smembers(`license_sessions:${licenseId}`);
			for (const token of tokens) {
				await redis.del(`license_session:${token}`);
			}
			await redis.del(`license_sessions:${licenseId}`);
		} catch {
			// Redis may have become unavailable after the test itself completed.
		}
	}
	try {
		redis.close();
	} catch {}
	if (database) await database.close({ timeout: 1 }).catch(() => undefined);
	if (createdDatabase) {
		await maintenance
			.unsafe(
				`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${databaseName}' AND pid <> pg_backend_pid()`,
			)
			.catch(() => undefined);
		await maintenance.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
	}
	await maintenance.close({ timeout: 1 }).catch(() => undefined);
}
