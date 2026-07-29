import { createHash } from "node:crypto";
import os from "node:os";

/**
 * Handles generating and caching a unique Hardware Identifier (HWID) for the host machine.
 * This provides a stable host signal for license device-limit enforcement.
 */
export class HardwareManager {
	private cachedHwid?: string;

	constructor(private readonly hardwareId?: string) {}

	/**
	 * Generates a consistent SHA-256 Hardware ID (HWID) based on the system's
	 * MAC addresses, OS platform, architecture, and CPU count.
	 *
	 * Results are cached in memory after the first invocation to avoid redundant I/O overhead.
	 *
	 * @returns {string} The computed 64-character hexadecimal HWID string.
	 */
	public getHwid(): string {
		if (this.cachedHwid) return this.cachedHwid;

		if (this.hardwareId !== undefined) {
			this.cachedHwid = createHash("sha256")
				.update(this.hardwareId.trim())
				.digest("hex");
			return this.cachedHwid;
		}

		const interfaces = os.networkInterfaces();
		const macAddresses: string[] = [];
		for (const name of Object.keys(interfaces)) {
			for (const net of interfaces[name] || []) {
				if (!net.internal && net.mac !== "00:00:00:00:00:00") {
					macAddresses.push(net.mac.toLowerCase());
				}
			}
		}
		const networkRaw = [...new Set(macAddresses)].sort().join(":");

		// Fallback to hostname if no external MAC address is found (e.g. some virtualized environments)
		const platformData = networkRaw
			? `${os.platform()}:${os.arch()}:${os.cpus().length}:${networkRaw}`
			: `${os.platform()}:${os.arch()}:${os.cpus().length}:${os.hostname()}`;

		this.cachedHwid = createHash("sha256").update(platformData).digest("hex");
		return this.cachedHwid;
	}
}
