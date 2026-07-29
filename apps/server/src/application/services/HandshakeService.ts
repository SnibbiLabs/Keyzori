import type { JsonObject, KeyType } from "../../domain/entities";
import { DomainError } from "../../domain/errors";
import type { IDeviceRepository } from "../../domain/repositories/IDeviceRepository";
import type { IKeyRepository } from "../../domain/repositories/IKeyRepository";
import type { ISessionRepository } from "../../domain/repositories/ISessionRepository";

export interface HandshakeResult {
	success: true;
	type: KeyType;
	customFields: JsonObject;
	sessionToken: string;
	sessionTtlSeconds: number;
}

export const SESSION_TTL_SECONDS = 45;

export class HandshakeService {
	constructor(
		private readonly keyRepo: IKeyRepository,
		private readonly deviceRepo: IDeviceRepository,
		private readonly sessionRepo: ISessionRepository,
	) {}

	async processHandshake(
		apiKey: string,
		hwid: string,
		sessionToken: string | undefined,
		ip: string,
	): Promise<HandshakeResult> {
		const keyData = await this.keyRepo.findByKeyWithWhitelists(apiKey);
		if (!keyData || keyData.revoked) {
			throw new DomainError(
				"Invalid or revoked API key",
				403,
				"LICENSE_INVALID_OR_REVOKED",
			);
		}

		if (
			keyData.whitelistedIps.length > 0 &&
			!keyData.whitelistedIps.some((entry) => entry.ip === ip)
		) {
			throw new DomainError(
				"IP address not whitelisted",
				403,
				"IP_NOT_WHITELISTED",
			);
		}
		if (
			keyData.whitelistedHwids.length > 0 &&
			!keyData.whitelistedHwids.some((entry) => entry.hwid === hwid)
		) {
			throw new DomainError(
				"HWID not whitelisted",
				403,
				"HWID_NOT_WHITELISTED",
			);
		}

		const now = new Date();
		const sessionBinding = { ip, hwid };
		const activationTime = keyData.firstActivatedAt ?? now;
		if (
			keyData.trialDurationMin > 0 &&
			now.getTime() >=
				activationTime.getTime() + keyData.trialDurationMin * 60_000
		) {
			throw new DomainError("Trial has expired", 403, "TRIAL_EXPIRED");
		}
		if (
			keyData.type === "SUBSCRIPTION" &&
			(!keyData.expiresAt || now >= keyData.expiresAt)
		) {
			throw new DomainError(
				"Subscription expired",
				403,
				"SUBSCRIPTION_EXPIRED",
			);
		}

		let activeSessionToken: string;
		let isNewSession: boolean;
		if (sessionToken) {
			if (
				!(await this.sessionRepo.refreshSession(
					keyData.id,
					sessionToken,
					sessionBinding,
					SESSION_TTL_SECONDS,
				))
			) {
				throw new DomainError(
					"Invalid or expired session token",
					403,
					"SESSION_INVALID_OR_EXPIRED",
				);
			}
			activeSessionToken = sessionToken;
			isNewSession = false;
		} else {
			const registration = await this.sessionRepo.registerSession(
				keyData.id,
				sessionBinding,
				SESSION_TTL_SECONDS,
				keyData.limitConcurrent,
			);
			if (registration.status === "limit-reached") {
				throw new DomainError(
					"Maximum concurrent sessions reached",
					403,
					"CONCURRENT_SESSION_LIMIT",
				);
			}
			activeSessionToken = registration.token;
			isNewSession = true;
		}
		if (isNewSession && keyData.type === "USAGE" && keyData.limitUsage <= 0) {
			await this.sessionRepo.removeSession(
				keyData.id,
				activeSessionToken,
				sessionBinding,
			);
			throw new DomainError("Usage balance exhausted", 403, "USAGE_EXHAUSTED");
		}

		try {
			await this.deviceRepo.withKeyRegistrationLock(
				keyData.id,
				async (deviceRepo) => {
					let device = await deviceRepo.findDevice(ip, hwid);
					if (!device) device = await deviceRepo.createDevice(ip, hwid);

					const mapping = await deviceRepo.findMapping(keyData.id, device.id);
					if (!mapping) {
						const usage = await deviceRepo.getKeyDeviceUsage(
							keyData.id,
							ip,
							hwid,
						);
						if (
							keyData.limitIp > 0 &&
							!usage.ipRegistered &&
							usage.uniqueIps >= keyData.limitIp
						) {
							throw new DomainError(
								"IP registration threshold exceeded",
								403,
								"IP_REGISTRATION_LIMIT",
							);
						}
						if (
							keyData.limitHwid > 0 &&
							!usage.hwidRegistered &&
							usage.uniqueHwids >= keyData.limitHwid
						) {
							throw new DomainError(
								"Hardware registration threshold exceeded",
								403,
								"HWID_REGISTRATION_LIMIT",
							);
						}
						await deviceRepo.createMapping(keyData.id, device.id);
					}
					if (
						isNewSession &&
						keyData.type === "USAGE" &&
						!(await deviceRepo.consumeUsage(keyData.id))
					) {
						throw new DomainError(
							"Usage balance exhausted",
							403,
							"USAGE_EXHAUSTED",
						);
					}
				},
			);

			if (keyData.trialDurationMin > 0 && !keyData.firstActivatedAt) {
				await this.keyRepo.update(keyData.id, {
					firstActivatedAt: activationTime,
				});
			}
		} catch (error) {
			if (isNewSession) {
				await this.sessionRepo.removeSession(
					keyData.id,
					activeSessionToken,
					sessionBinding,
				);
			}
			throw error;
		}

		return {
			success: true,
			type: keyData.type,
			customFields: keyData.customFields,
			sessionToken: activeSessionToken,
			sessionTtlSeconds: SESSION_TTL_SECONDS,
		};
	}

	async logout(
		apiKey: string,
		sessionToken: string,
		hwid: string,
		ip: string,
	): Promise<{ success: true }> {
		const keyData = await this.keyRepo.findByKeyWithWhitelists(apiKey);
		if (keyData) {
			await this.sessionRepo.removeSession(keyData.id, sessionToken, {
				ip,
				hwid,
			});
		}
		return { success: true };
	}
}
