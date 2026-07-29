import type { Server } from "bun";
import { BlockList, isIP } from "node:net";

export type TrustedProxyHeader = "x-forwarded-for" | "cf-connecting-ip";

export interface ClientIpOptions {
	trustProxyHeaders: boolean;
	trustedProxyCidrs: string[];
	trustedProxyHeader?: TrustedProxyHeader;
}

const FALLBACK_IP = "127.0.0.1";
const MAX_FORWARDED_CHAIN_LENGTH = 32;

function normalizeIp(value: string): string | null {
	const address = value.trim();
	const family = isIP(address);
	if (family === 4) {
		return address
			.split(".")
			.map((part) => String(Number(part)))
			.join(".");
	}
	if (family !== 6) return null;
	try {
		const hostname = new URL(`http://[${address}]/`).hostname;
		return hostname.slice(1, -1).toLowerCase();
	} catch {
		return null;
	}
}

/** Resolves client addresses without rebuilding trusted CIDR state per request. */
export class ClientIpResolver {
	private readonly trustedProxies = new BlockList();
	private readonly header: TrustedProxyHeader;

	constructor(private readonly options: ClientIpOptions) {
		this.header = options.trustedProxyHeader ?? "x-forwarded-for";
		for (const cidr of options.trustedProxyCidrs) {
			const [address, prefixText] = cidr.split("/");
			const family = address ? isIP(address) : 0;
			if (!address || !prefixText || family === 0) continue;
			this.trustedProxies.addSubnet(
				address,
				Number(prefixText),
				family === 4 ? "ipv4" : "ipv6",
			);
		}
	}

	public resolve(request: Request, server: Server<unknown> | null): string {
		const socketIp =
			normalizeIp(server?.requestIP(request)?.address ?? FALLBACK_IP) ??
			FALLBACK_IP;
		if (!this.options.trustProxyHeaders || !this.isTrusted(socketIp)) {
			return socketIp;
		}

		if (this.header === "cf-connecting-ip") {
			return (
				normalizeIp(request.headers.get("cf-connecting-ip") ?? "") ?? socketIp
			);
		}

		const forwarded = request.headers.get("x-forwarded-for");
		if (!forwarded) return socketIp;
		const chain = forwarded.split(",");
		if (
			chain.length > MAX_FORWARDED_CHAIN_LENGTH ||
			chain.some((entry) => normalizeIp(entry) === null)
		) {
			return socketIp;
		}

		let current = socketIp;
		for (let index = chain.length - 1; index >= 0; index--) {
			if (!this.isTrusted(current)) return current;
			current = normalizeIp(chain[index] ?? "") ?? socketIp;
		}
		return current;
	}

	private isTrusted(address: string): boolean {
		const family = isIP(address);
		return (
			family > 0 &&
			this.trustedProxies.check(address, family === 4 ? "ipv4" : "ipv6")
		);
	}
}

/** Compatibility helper. Long-lived servers should reuse ClientIpResolver. */
export function getClientIp(
	request: Request,
	server: Server<unknown> | null,
	options: ClientIpOptions,
): string {
	return new ClientIpResolver(options).resolve(request, server);
}
