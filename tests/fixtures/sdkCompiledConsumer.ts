import { LicenseClient } from "keyzori";

const serverUrl = Bun.env.KEYZORI_TEST_SERVER_URL;
const licenseKey = Bun.env.KEYZORI_TEST_LICENSE_KEY;
const mode = Bun.env.KEYZORI_TEST_MODE ?? "success";
if (!serverUrl || !licenseKey)
	throw new Error("Compiled consumer test is not configured");

const client = new LicenseClient({
	licenseKey,
	serverUrl,
	deviceId: " compiled-consumer-device ",
	heartbeatIntervalMs: 60_000,
	requestTimeoutMs: 5_000,
});

if (mode === "redirect") {
	try {
		await client.activate();
		throw new Error("Redirected activation unexpectedly succeeded");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message === "Redirected activation unexpectedly succeeded") throw error;
		console.log(JSON.stringify({ redirectRejected: true }));
	}
} else {
	const heartbeat = new Promise<void>((resolve, reject) => {
		client.events.once("heartbeat:success", (activation) => {
			if (
				activation.licenseType !== "metered" ||
				activation.metadata.compiled !== "refreshed"
			) {
				reject(new Error("Heartbeat did not refresh the activation data"));
				return;
			}
			resolve();
		});
	});
	const activation = await client.activate();
	if (
		activation.licenseType !== "metered" ||
		activation.metadata.compiled !== true
	) {
		throw new Error("Activation returned unexpected data");
	}
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
	const usage = await client.consume({
		meter: "builds",
		units: 2,
		eventId: "compiled-event-1",
	});
	if (usage.remaining !== 8) throw new Error("Usage result was not returned");
	await client.deactivate();
	console.log(JSON.stringify({ success: true, remaining: usage.remaining }));
}
