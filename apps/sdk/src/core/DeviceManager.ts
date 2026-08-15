import { createHash } from "node:crypto";
import os from "node:os";

/** Generates and caches the stable device digest sent to Keyzori. */
export class DeviceManager {
	private cachedDeviceId?: string;

	constructor(private readonly configuredDeviceId?: string) {}

	/** Returns a stable SHA-256 device identifier for this client process. */
	public getDeviceId(): string {
		if (this.cachedDeviceId) return this.cachedDeviceId;

		if (this.configuredDeviceId !== undefined) {
			this.cachedDeviceId = createHash("sha256")
				.update(this.configuredDeviceId.trim())
				.digest("hex");
			return this.cachedDeviceId;
		}

		const macAddresses: string[] = [];
		for (const addresses of Object.values(os.networkInterfaces())) {
			for (const address of addresses ?? []) {
				if (!address.internal && address.mac !== "00:00:00:00:00:00") {
					macAddresses.push(address.mac.toLowerCase());
				}
			}
		}

		const networkIdentity = [...new Set(macAddresses)].sort().join(":");
		const hostIdentity = networkIdentity
			? `${os.platform()}:${os.arch()}:${os.cpus().length}:${networkIdentity}`
			: `${os.platform()}:${os.arch()}:${os.cpus().length}:${os.hostname()}`;

		this.cachedDeviceId = createHash("sha256")
			.update(hostIdentity)
			.digest("hex");
		return this.cachedDeviceId;
	}
}
