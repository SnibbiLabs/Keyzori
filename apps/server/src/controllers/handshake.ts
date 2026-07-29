import { createHash } from "node:crypto";
import Elysia from "elysia";
import type { HandshakeService } from "../application/services/HandshakeService";
import type { ClientIpOptions } from "./clientIp";
import { DomainError } from "../domain/errors";
import { ClientIpResolver } from "./clientIp";
import {
	enforceRateLimit,
	type RedisSlidingWindowRateLimiter,
} from "../plugins/ratelimit";
import {
	ErrorResponseSchema,
	HandshakeInputSchema,
	HandshakeResponseSchema,
	LogoutInputSchema,
	SuccessResponseSchema,
} from "./validation";

export interface LicenseRateLimitOptions {
	limiter: RedisSlidingWindowRateLimiter;
	requestsPerMinute: number;
}

function hashPrincipal(...parts: string[]): string {
	return createHash("sha256").update(parts.join("\0")).digest("hex");
}

export const handshakePlugin = (
	handshakeService: HandshakeService,
	clientIpOptions: ClientIpOptions = {
		trustProxyHeaders: false,
		trustedProxyCidrs: [],
	},
	rateLimitOptions?: LicenseRateLimitOptions,
) => {
	const clientIpResolver = new ClientIpResolver(clientIpOptions);
	const limitPrincipal = async (
		apiKey: string,
		hwid: string,
		sessionToken: string | undefined,
		set: Parameters<typeof enforceRateLimit>[3],
	) => {
		if (!rateLimitOptions) return;
		const principal = sessionToken
			? hashPrincipal(sessionToken)
			: hashPrincipal(apiKey, hwid);
		return await enforceRateLimit(
			rateLimitOptions.limiter,
			`ratelimit:license:${principal}`,
			rateLimitOptions.requestsPerMinute,
			set,
		);
	};

	return new Elysia({ tags: ["License"] })
		.onError(({ code, error, set }) => {
			if (error instanceof DomainError) {
				set.status = error.statusCode;
				return { error: error.message, code: error.code };
			}
			if (code === "VALIDATION") {
				set.status = 400;
				return { error: error.message, code: "INVALID_REQUEST" as const };
			}
		})
		.post(
			"/v1/handshake",
			async ({ body, request, server, set }) => {
				const limited = await limitPrincipal(
					body.apiKey,
					body.hwid,
					body.sessionToken,
					set,
				);
				if (limited) return limited;
				return await handshakeService.processHandshake(
					body.apiKey,
					body.hwid,
					body.sessionToken,
					clientIpResolver.resolve(request, server),
				);
			},
			{
				body: HandshakeInputSchema,
				response: {
					200: HandshakeResponseSchema,
					400: ErrorResponseSchema,
					403: ErrorResponseSchema,
					429: ErrorResponseSchema,
					500: ErrorResponseSchema,
				},
				detail: {
					operationId: "handshakeLicense",
					summary: "Validate or refresh a license session",
					description:
						"Validates the key, expiry, network and hardware limits, then creates or refreshes the supplied session.",
				},
			},
		)
		.post(
			"/v1/logout",
			async ({ body, request, server, set }) => {
				const limited = await limitPrincipal(
					body.apiKey,
					body.hwid,
					body.sessionToken,
					set,
				);
				if (limited) return limited;
				return await handshakeService.logout(
					body.apiKey,
					body.sessionToken,
					body.hwid,
					clientIpResolver.resolve(request, server),
				);
			},
			{
				body: LogoutInputSchema,
				response: {
					200: SuccessResponseSchema,
					400: ErrorResponseSchema,
					429: ErrorResponseSchema,
					500: ErrorResponseSchema,
				},
				detail: {
					operationId: "logoutLicense",
					summary: "Release a license session",
					description:
						"Removes the session immediately instead of waiting for its Redis TTL.",
				},
			},
		);
};
