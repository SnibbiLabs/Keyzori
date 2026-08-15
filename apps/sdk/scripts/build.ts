import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const packageDirectory = resolve(import.meta.dir, "..");
const outputDirectory = resolve(packageDirectory, "dist");

await rm(outputDirectory, { recursive: true, force: true });

const bundle = await Bun.build({
	entrypoints: [resolve(packageDirectory, "src/index.ts")],
	outdir: outputDirectory,
	target: "node",
});
if (!bundle.success) {
	for (const log of bundle.logs) console.error(log);
	process.exit(1);
}

const declarations = Bun.spawn(["bunx", "tsc"], {
	cwd: packageDirectory,
	stdout: "inherit",
	stderr: "inherit",
});
const exitCode = await declarations.exited;
if (exitCode !== 0) process.exit(exitCode);
