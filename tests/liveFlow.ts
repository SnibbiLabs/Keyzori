import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { RedisClient, SQL } from "bun";
import { LicenseClient } from "../apps/sdk/src/core/LicenseClient";

if (Bun.env.LIVE_TEST_ENABLED !== "true") {
	throw new Error(
		"Set LIVE_TEST_ENABLED=true to run the live integration test.",
	);
}

for (const name of ["DATABASE_URL", "REDIS_URL", "ADMIN_API_KEY"] as const) {
	const value = Bun.env[name];
	if (
		!value ||
		value.includes("your_secure_") ||
		value.includes("replace_with_")
	) {
		throw new Error(`${name} is missing or still uses a placeholder.`);
	}
}

const serverDirectory = resolve(import.meta.dir, "../apps/server");
const serverBinary = resolve(
	serverDirectory,
	"dist",
	process.platform === "win32" ? "keyzori-server.exe" : "keyzori-server",
);
const cliBinary = resolve(
	serverDirectory,
	"dist",
	process.platform === "win32" ? "keyzori-admin.exe" : "keyzori-admin",
);
if (!existsSync(serverBinary) || !existsSync(cliBinary)) {
	throw new Error("Build the server runtime binaries first.");
}

const runId = crypto.randomUUID();
const startedAt = new Date();
const port = 32_000 + Math.floor(Math.random() * 4_000);
const serverUrl = `http://127.0.0.1:${port}`;
const database = new SQL(Bun.env.DATABASE_URL as string);
const redis = new RedisClient(Bun.env.REDIS_URL);
let userId: string | undefined;
let keyId: string | undefined;
let server: ReturnType<typeof Bun.spawn> | undefined;

async function waitForServer(): Promise<void> {
	for (let attempt = 0; attempt < 60; attempt++) {
		if (server?.exitCode !== null) {
			throw new Error(
				`Server exited during startup with code ${server?.exitCode}.`,
			);
		}
		try {
			const response = await fetch(`${serverUrl}/health`);
			if (response.ok) return;
		} catch {
			// The server may still be applying migrations or connecting to Redis.
		}
		await Bun.sleep(250);
	}
	throw new Error("Server did not become healthy within 15 seconds.");
}

async function runCli(arguments_: string[]): Promise<string> {
	const process = Bun.spawn([cliBinary, ...arguments_], {
		cwd: serverDirectory,
		env: Bun.env,
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
	return stdout;
}

function parseCreatedRecord(output: string): { id: string; key?: string } {
	const value: unknown = JSON.parse(output);
	if (
		!value ||
		typeof value !== "object" ||
		!("id" in value) ||
		typeof value.id !== "string"
	) {
		throw new Error("CLI returned an invalid created record.");
	}
	const key =
		"key" in value && typeof value.key === "string" ? value.key : undefined;
	return { id: value.id, key };
}

try {
	await database`SELECT 1`;
	await redis.connect();
	console.log("Live dependencies reachable.");

	server = Bun.spawn([serverBinary], {
		cwd: serverDirectory,
		env: {
			...Bun.env,
			PORT: String(port),
			OPENAPI_ENABLED: "true",
		},
		stdout: "ignore",
		stderr: "inherit",
	});
	await waitForServer();
	console.log("Compiled server healthy.");

	const docs = await fetch(`${serverUrl}/docs/openapi.json`);
	if (!docs.ok) throw new Error(`OpenAPI request failed with ${docs.status}.`);
	const openapi: unknown = await docs.json();
	if (!openapi || typeof openapi !== "object" || !("paths" in openapi)) {
		throw new Error("OpenAPI response was invalid.");
	}
	console.log("Live OpenAPI document reachable.");

	const user = parseCreatedRecord(
		await runCli([
			"create-user",
			"--email",
			`codex-live-${runId}@example.invalid`,
			"--name",
			"Codex Live Test",
		]),
	);
	userId = user.id;
	const key = parseCreatedRecord(
		await runCli([
			"create-key",
			"--user-id",
			userId,
			"--type",
			"PERPETUAL",
			"--limit-ip",
			"1",
			"--limit-hwid",
			"1",
			"--limit-concurrent",
			"1",
			"--custom-fields",
			JSON.stringify({ liveTest: runId }),
		]),
	);
	if (!key.key)
		throw new Error("CLI did not return the created license secret.");
	keyId = key.id;
	console.log("CLI admin flow created a disposable user and key.");

	const storedKeys = await database<
		{
			id: string;
			keyHash: string;
			keyPrefix: string;
			revoked: boolean;
		}[]
	>`
		SELECT "id", "keyHash", "keyPrefix", "revoked"
		FROM "ApiKey" WHERE "id" = ${keyId}
	`;
	if (
		storedKeys.length !== 1 ||
		storedKeys[0]?.revoked !== false ||
		storedKeys[0]?.keyHash.length !== 64 ||
		storedKeys[0]?.keyPrefix !== key.key.slice(0, 12)
	) {
		throw new Error("Created key was not persisted correctly.");
	}
	const listedKeys = await runCli(["list-keys"]);
	if (
		!listedKeys.includes(keyId) ||
		!listedKeys.includes(`${key.key.slice(0, 12)}...`)
	) {
		throw new Error("Administrative key listing did not mask the secret.");
	}

	const contenders = [
		new LicenseClient({ apiKey: key.key, serverUrl }),
		new LicenseClient({ apiKey: key.key, serverUrl }),
	];
	const originalConsoleError = console.error;
	console.error = () => {};
	const results = await Promise.allSettled(
		contenders.map(async (client) => await client.initialize()),
	);
	console.error = originalConsoleError;
	const successfulIndexes = results.flatMap((result, index) =>
		result.status === "fulfilled" ? [index] : [],
	);
	if (successfulIndexes.length !== 1) {
		throw new Error(
			`Expected exactly one concurrent session, received ${successfulIndexes.length}.`,
		);
	}
	const successfulResult = results[successfulIndexes[0] ?? -1];
	if (
		successfulResult?.status !== "fulfilled" ||
		successfulResult.value.liveTest !== runId
	) {
		throw new Error("SDK did not receive the persisted custom fields.");
	}
	if ((await redis.scard(`sessions:${keyId}`)) !== 1) {
		throw new Error("Concurrent session limit was not enforced in Redis.");
	}
	const [activeToken] = await redis.smembers(`sessions:${keyId}`);
	if (!activeToken) throw new Error("Active Redis session token was missing.");
	const replayResponse = await fetch(`${serverUrl}/v1/handshake`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			apiKey: key.key,
			hwid: `different-${runId}`,
			sessionToken: activeToken,
		}),
	});
	const replayBody = (await replayResponse.json()) as { error?: string };
	if (
		replayResponse.status !== 403 ||
		replayBody.error !== "Invalid or expired session token"
	) {
		throw new Error(
			"Session token was accepted from a different client context.",
		);
	}
	await contenders[successfulIndexes[0] ?? -1]?.destroy();
	if ((await redis.scard(`sessions:${keyId}`)) !== 0) {
		throw new Error("SDK logout did not release the Redis session.");
	}
	console.log(
		"Atomic SDK concurrency, replay rejection, and logout flow passed.",
	);

	await runCli(["revoke-key", "--id", keyId]);
	const revokedRows = await database<{ revoked: boolean }[]>`
		SELECT "revoked" FROM "ApiKey" WHERE "id" = ${keyId}
	`;
	if (revokedRows[0]?.revoked !== true) {
		throw new Error("CLI revocation was not persisted.");
	}

	const rejectedSdk = new LicenseClient({ apiKey: key.key, serverUrl });
	const revokedConsoleError = console.error;
	console.error = () => {};
	try {
		await rejectedSdk.initialize();
		throw new Error("Revoked key unexpectedly initialized.");
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!error.message.includes("Invalid or revoked API key")
		) {
			throw error;
		}
	} finally {
		console.error = revokedConsoleError;
	}
	console.log("CLI revocation and SDK rejection flow passed.");
} finally {
	try {
		if (keyId) {
			const deviceRows = await database<{ id: string }[]>`
				SELECT d."id"
				FROM "RegisteredDevice" d
				INNER JOIN "KeyDeviceMapping" m ON m."registeredDeviceId" = d."id"
				WHERE m."apiKeyId" = ${keyId}
			`;
			const sessionTokens = await redis.smembers(`sessions:${keyId}`);
			for (const token of sessionTokens) {
				await redis.del(`session_ttl:${keyId}:${token}`);
			}
			await redis.del(`sessions:${keyId}`);

			if (userId) await database`DELETE FROM "User" WHERE "id" = ${userId}`;
			for (const device of deviceRows) {
				await database`
					DELETE FROM "RegisteredDevice"
					WHERE "id" = ${device.id}
						AND "createdAt" >= ${startedAt}
						AND NOT EXISTS (
							SELECT 1 FROM "KeyDeviceMapping"
							WHERE "registeredDeviceId" = ${device.id}
						)
				`;
			}
		} else if (userId) {
			await database`DELETE FROM "User" WHERE "id" = ${userId}`;
		}
		console.log("Disposable database and Redis records cleaned up.");
	} finally {
		if (server && server.exitCode === null) {
			server.kill();
			await server.exited;
		}
		redis.close();
		await database.close({ timeout: 1 });
	}
}
