import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const migrate = mock(async () => {});
mock.module("drizzle-orm/bun-sql/postgres/migrator", () => ({ migrate }));

import { db } from "../db";
import { migrateDatabase } from "../db/migrate";

describe("migrateDatabase", () => {
	let previousPath: string | undefined;

	beforeAll(() => {
		previousPath = Bun.env.DRIZZLE_MIGRATIONS_PATH;
		Bun.env.DRIZZLE_MIGRATIONS_PATH = "apps/server/drizzle";
	});

	afterAll(() => {
		if (previousPath === undefined) delete Bun.env.DRIZZLE_MIGRATIONS_PATH;
		else Bun.env.DRIZZLE_MIGRATIONS_PATH = previousPath;
	});

	test("uses the configured migrations folder", async () => {
		await migrateDatabase();
		expect(migrate).toHaveBeenCalledWith(db, {
			migrationsFolder: "apps/server/drizzle",
		});
	});

	test("fails clearly when no migrations folder exists", async () => {
		const originalDirectory = process.cwd();
		const emptyDirectory = mkdtempSync(join(tmpdir(), "keyzori-migrations-"));
		Bun.env.DRIZZLE_MIGRATIONS_PATH = join(emptyDirectory, "missing");
		process.chdir(emptyDirectory);
		try {
			await expect(migrateDatabase()).rejects.toThrow(
				"Drizzle migrations folder was not found",
			);
		} finally {
			process.chdir(originalDirectory);
			rmSync(emptyDirectory, { recursive: true, force: true });
		}
	});

	test("fails explicitly instead of rewriting negative legacy limits", () => {
		const migration = readFileSync(
			"apps/server/drizzle/20260729061720_colossal_greymalkin/migration.sql",
			"utf8",
		);
		expect(migration).toContain("ApiKey contains negative legacy limit values");
		expect(migration).toContain('WHERE "limitIp" < 0');
		expect(migration).not.toMatch(/UPDATE\s+"ApiKey"/i);
	});
});
