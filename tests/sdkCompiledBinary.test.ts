import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fixture = resolve(import.meta.dir, "fixtures/sdkCompiledConsumer.ts");
let temporaryDirectory = "";
let executable = "";

async function runCompiled(
	serverUrl: string,
	mode: "success" | "redirect",
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn([executable], {
		env: {
			...process.env,
			KEYZORI_TEST_SERVER_URL: serverUrl,
			KEYZORI_TEST_LICENSE_KEY: "lic_compiled-test-key",
			KEYZORI_TEST_MODE: mode,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

const compiledDescribe =
	Bun.env.KEYZORI_SDK_COMPILED_TEST_ENABLED === "true"
		? describe
		: describe.skip;

compiledDescribe("compiled downstream SDK consumer", () => {
	beforeAll(async () => {
		temporaryDirectory = mkdtempSync(join(tmpdir(), "keyzori-sdk-compiled-"));
		const temporaryFixture = join(temporaryDirectory, "sdkCompiledConsumer.ts");
		const executableBase = join(temporaryDirectory, "consumer");
		executable = executableBase;
		copyFileSync(fixture, temporaryFixture);
		const modulesDirectory = join(temporaryDirectory, "node_modules");
		mkdirSync(modulesDirectory);
		symlinkSync(
			resolve(import.meta.dir, "../apps/sdk"),
			join(modulesDirectory, "keyzori"),
			process.platform === "win32" ? "junction" : "dir",
		);
		const build = Bun.spawn(
			[
				"bun",
				"build",
				temporaryFixture,
				"--compile",
				"--outfile",
				executableBase,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const [exitCode, stderr] = await Promise.all([
			build.exited,
			new Response(build.stderr).text(),
		]);
		if (exitCode !== 0) {
			throw new Error(`Compiled consumer build failed: ${stderr}`);
		}
		if (process.platform === "win32" && existsSync(`${executableBase}.exe`)) {
			executable = `${executableBase}.exe`;
		}
		if (!existsSync(executable)) {
			throw new Error("Bun did not create the compiled consumer executable");
		}
	});

	afterAll(() => {
		if (temporaryDirectory) {
			rmSync(temporaryDirectory, { recursive: true, force: true });
		}
	});

	test("activates, heartbeats, consumes usage, and deactivates", async () => {
		const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
		const activationToken = "11111111-1111-4111-8111-111111111111";
		const refreshedToken = "22222222-2222-4222-8222-222222222222";
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				const body = (await request.json()) as Record<string, unknown>;
				requests.push({ path: url.pathname, body });
				if (url.pathname === "/v1/deactivate") {
					return Response.json({ success: true });
				}
				if (url.pathname === "/v1/usage") {
					return Response.json({
						success: true,
						meter: body.meter,
						units: body.units,
						eventId: body.eventId,
						remaining: 8,
					});
				}
				const heartbeat = url.pathname === "/v1/heartbeat";
				return Response.json({
					success: true,
					licenseType: "metered",
					metadata: { compiled: heartbeat ? "refreshed" : true },
					sessionToken: heartbeat ? refreshedToken : activationToken,
					sessionTtlSeconds: 1,
				});
			},
		});
		try {
			const result = await runCompiled(server.url.toString(), "success");
			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toContain('"success":true');
			expect(result.stdout).toContain('"remaining":8');
			expect(requests.map(({ path }) => path)).toEqual([
				"/v1/activate",
				"/v1/heartbeat",
				"/v1/usage",
				"/v1/deactivate",
			]);
			const expectedDeviceId = createHash("sha256")
				.update("compiled-consumer-device")
				.digest("hex");
			expect(
				requests.every(({ body }) => body.deviceId === expectedDeviceId),
			).toBe(true);
			expect(requests[0]?.body).toEqual({
				licenseKey: "lic_compiled-test-key",
				deviceId: expectedDeviceId,
			});
			expect(requests[1]?.body).toEqual({
				sessionToken: activationToken,
				deviceId: expectedDeviceId,
			});
			expect(requests[2]?.body).toEqual({
				sessionToken: refreshedToken,
				deviceId: expectedDeviceId,
				meter: "builds",
				units: 2,
				eventId: "compiled-event-1",
			});
			expect(requests[3]?.body).toEqual({
				sessionToken: refreshedToken,
				deviceId: expectedDeviceId,
			});
			expect(
				requests.slice(1).every(({ body }) => !("licenseKey" in body)),
			).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	test("rejects 307 redirects without forwarding credentials or bodies", async () => {
		let redirectTargetRequests = 0;
		const target = Bun.serve({
			port: 0,
			fetch() {
				redirectTargetRequests++;
				return Response.json({ success: true });
			},
		});
		const origin = Bun.serve({
			port: 0,
			fetch() {
				return Response.redirect(new URL("/sink", target.url), 307);
			},
		});
		try {
			const result = await runCompiled(origin.url.toString(), "redirect");
			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toContain('"redirectRejected":true');
			expect(redirectTargetRequests).toBe(0);
		} finally {
			origin.stop(true);
			target.stop(true);
		}
	});
});
