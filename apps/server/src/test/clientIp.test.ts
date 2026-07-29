import { describe, expect, test } from "bun:test";
import { getClientIp } from "../controllers/clientIp";

describe("getClientIp", () => {
	test("ignores forwarded headers by default", () => {
		const request = new Request("http://localhost", {
			headers: { "x-forwarded-for": "203.0.113.10" },
		});
		expect(
			getClientIp(request, null, {
				trustProxyHeaders: false,
				trustedProxyCidrs: [],
			}),
		).toBe("127.0.0.1");
	});

	test("stops at the first untrusted address when walking from the edge", () => {
		const request = new Request("http://localhost", {
			headers: { "x-forwarded-for": "203.0.113.10, 10.0.0.2" },
		});
		expect(
			getClientIp(request, null, {
				trustProxyHeaders: true,
				trustedProxyCidrs: ["127.0.0.0/8"],
			}),
		).toBe("10.0.0.2");
	});

	test("ignores proxy headers from untrusted peers and invalid addresses", () => {
		const untrusted = new Request("http://localhost", {
			headers: { "x-forwarded-for": "203.0.113.10" },
		});
		expect(
			getClientIp(untrusted, null, {
				trustProxyHeaders: true,
				trustedProxyCidrs: ["10.0.0.0/8"],
			}),
		).toBe("127.0.0.1");

		const invalid = new Request("http://localhost", {
			headers: { "cf-connecting-ip": "not-an-ip" },
		});
		expect(
			getClientIp(invalid, null, {
				trustProxyHeaders: true,
				trustedProxyCidrs: ["127.0.0.0/8"],
			}),
		).toBe("127.0.0.1");
	});

	test("walks trusted proxy hops without accepting a spoofed left entry", () => {
		const request = new Request("http://localhost", {
			headers: {
				"x-forwarded-for": "198.51.100.99, 203.0.113.20, 10.0.0.2",
			},
		});
		expect(
			getClientIp(request, null, {
				trustProxyHeaders: true,
				trustedProxyCidrs: ["127.0.0.0/8", "10.0.0.0/8"],
			}),
		).toBe("203.0.113.20");
	});

	test("uses CF-Connecting-IP only in explicit Cloudflare mode", () => {
		const request = new Request("http://localhost", {
			headers: {
				"cf-connecting-ip": "203.0.113.44",
				"x-forwarded-for": "198.51.100.11",
			},
		});
		const base = {
			trustProxyHeaders: true,
			trustedProxyCidrs: ["127.0.0.0/8"],
		};
		expect(getClientIp(request, null, base)).toBe("198.51.100.11");
		expect(
			getClientIp(request, null, {
				...base,
				trustedProxyHeader: "cf-connecting-ip",
			}),
		).toBe("203.0.113.44");
	});

	test("falls back to the socket for malformed or excessive chains", () => {
		for (const forwarded of [
			"203.0.113.1, not-an-ip",
			Array.from({ length: 33 }, (_, index) => `10.0.0.${index + 1}`).join(","),
		]) {
			expect(
				getClientIp(
					new Request("http://localhost", {
						headers: { "x-forwarded-for": forwarded },
					}),
					null,
					{
						trustProxyHeaders: true,
						trustedProxyCidrs: ["127.0.0.0/8"],
					},
				),
			).toBe("127.0.0.1");
		}
	});
});
