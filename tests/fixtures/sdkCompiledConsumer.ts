import { LicenseClient } from "keyzori";

const serverUrl = Bun.env.KEYZORI_TEST_SERVER_URL;
const apiKey = Bun.env.KEYZORI_TEST_API_KEY;
const mode = Bun.env.KEYZORI_TEST_MODE ?? "success";
if (!serverUrl || !apiKey)
	throw new Error("Compiled consumer test is not configured");

const client = new LicenseClient({
	apiKey,
	serverUrl,
	hardwareId: " compiled-consumer-machine ",
	heartbeatIntervalMs: 60_000,
	requestTimeoutMs: 5_000,
});

if (mode === "redirect") {
	try {
		await client.initialize();
		throw new Error("Redirected handshake unexpectedly succeeded");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message === "Redirected handshake unexpectedly succeeded") throw error;
		console.log(JSON.stringify({ redirectRejected: true }));
	}
} else {
	const heartbeat = new Promise<void>((resolve) => {
		client.events.once("heartbeat:success", resolve);
	});
	await client.initialize();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			heartbeat,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(
					() => reject(new Error("Clamped heartbeat did not run")),
					5_000,
				);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
	await client.destroy();
	console.log(JSON.stringify({ success: true }));
}
