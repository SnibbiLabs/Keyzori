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
			KEYZORI_TEST_API_KEY: "compiled-test-key",
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
	Bun.env.SDK_COMPILED_TEST_ENABLED === "true" ? describe : describe.skip;

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

	test("initializes, clamps heartbeat timing, reuses the session, and logs out", async () => {
		const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
		const sessionToken = "11111111-1111-4111-8111-111111111111";
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				const body = (await request.json()) as Record<string, unknown>;
				requests.push({ path: url.pathname, body });
				if (url.pathname === "/v1/logout") {
					return Response.json({ success: true });
				}
				return Response.json({
					success: true,
					type: "PERPETUAL",
					customFields: { compiled: true },
					sessionToken,
					sessionTtlSeconds: 1,
				});
			},
		});
		try {
			const result = await runCompiled(server.url.toString(), "success");
			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toContain('"success":true');
			expect(requests.map(({ path }) => path)).toEqual([
				"/v1/handshake",
				"/v1/handshake",
				"/v1/logout",
			]);
			const expectedHwid = createHash("sha256")
				.update("compiled-consumer-machine")
				.digest("hex");
			expect(requests.every(({ body }) => body.hwid === expectedHwid)).toBe(
				true,
			);
			expect(requests[0]?.body.sessionToken).toBeUndefined();
			expect(requests[1]?.body.sessionToken).toBe(sessionToken);
			expect(requests[2]?.body.sessionToken).toBe(sessionToken);
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
