import { $ } from "bun";
import { describe, expect, it } from "bun:test";

const cliEntrypoint = `${import.meta.dir}/../cli/index.ts`;

describe("server administration CLI", () => {
	it("displays help without opening a database connection", async () => {
		const { stdout } = await $`bun ${cliEntrypoint} --help`.quiet();
		const output = stdout.toString();
		expect(output).toContain("Usage: keyzori-admin");
		expect(output).toContain("create-key");
		expect(output).toContain("list-keys");
		expect(output).toContain("revoke-key");
		expect(output).toContain("create-user");
	});

	it("requires the server database configuration for commands", async () => {
		const result = await $`bun ${cliEntrypoint} list-keys`
			.env({ ...process.env, DATABASE_URL: "" })
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain(
			"DATABASE_URL must be configured",
		);
	});

	it("rejects partially numeric limit values before connecting", async () => {
		const result =
			await $`bun ${cliEntrypoint} create-key --user-id u1 --limit-ip 1abc`
				.env({ ...process.env, DATABASE_URL: "" })
				.quiet()
				.nothrow();
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain(
			"Expected a non-negative integer",
		);
	});

	it("rejects limits above PostgreSQL's integer ceiling", async () => {
		const result =
			await $`bun ${cliEntrypoint} create-key --user-id u1 --limit-ip 2147483648`
				.env({ ...process.env, DATABASE_URL: "" })
				.quiet()
				.nothrow();
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("no greater than 2147483647");
	});
});
