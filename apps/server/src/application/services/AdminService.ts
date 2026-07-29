import { DomainError, NotFoundError } from "../../domain/errors";
import type { ApiKey, JsonObject, KeyType, User } from "../../domain/entities";
import type { IKeyRepository } from "../../domain/repositories/IKeyRepository";
import type { IUserRepository } from "../../domain/repositories/IUserRepository";
import { MAX_LICENSE_LIMIT } from "../../domain/licenseLimits";

export interface CreateKeyInput {
	userId: string;
	type: KeyType;
	limitIp?: number;
	limitHwid?: number;
	limitConcurrent?: number;
	limitUsage?: number;
	trialDurationMin?: number;
	customFields?: JsonObject;
	expiresAt?: string;
}

export interface UpdateKeyInput
	extends Partial<Omit<CreateKeyInput, "expiresAt">> {
	expiresAt?: string | null;
	revoked?: boolean;
}

export interface UpdateUserInput {
	email?: string;
	name?: string;
	customFields?: JsonObject;
}

export class AdminService {
	constructor(
		private readonly keyRepo: IKeyRepository,
		private readonly userRepo: IUserRepository,
	) {}

	async createUser(
		email: string,
		name: string,
		customFields: JsonObject = {},
	): Promise<User> {
		const normalizedEmail = email.trim().toLowerCase();
		const normalizedName = name.trim();
		if (!normalizedName) throw new DomainError("User name is required");
		return await this.userRepo.create(
			normalizedEmail,
			normalizedName,
			customFields,
		);
	}

	async listUsers(): Promise<User[]> {
		return await this.userRepo.findAll();
	}

	async getUser(id: string): Promise<User> {
		const user = await this.userRepo.findById(id);
		if (!user) throw new NotFoundError("User");
		return user;
	}

	async updateUser(id: string, data: UpdateUserInput): Promise<User> {
		await this.getUser(id);
		if (
			data.email === undefined &&
			data.name === undefined &&
			data.customFields === undefined
		) {
			throw new DomainError("At least one user field is required");
		}
		const email = data.email?.trim().toLowerCase();
		const name = data.name?.trim();
		if (data.email !== undefined && !email) {
			throw new DomainError("User email is required");
		}
		if (data.name !== undefined && !name) {
			throw new DomainError("User name is required");
		}
		return await this.userRepo.update(id, {
			...(email === undefined ? {} : { email }),
			...(name === undefined ? {} : { name }),
			...(data.customFields === undefined
				? {}
				: { customFields: data.customFields }),
		});
	}

	async deleteUser(id: string): Promise<void> {
		await this.getUser(id);
		await this.userRepo.delete(id);
	}

	async createKey(data: CreateKeyInput): Promise<ApiKey> {
		const limits = [
			data.limitIp,
			data.limitHwid,
			data.limitConcurrent,
			data.limitUsage,
			data.trialDurationMin,
		].filter((value): value is number => value !== undefined);
		if (
			limits.some(
				(value) =>
					!Number.isInteger(value) || value < 0 || value > MAX_LICENSE_LIMIT,
			)
		) {
			throw new DomainError(
				`License limits must be non-negative integers no greater than ${MAX_LICENSE_LIMIT}`,
			);
		}
		if (!(await this.userRepo.findById(data.userId))) {
			throw new NotFoundError("User");
		}
		if (data.type === "USAGE" && (data.limitUsage ?? 0) < 1) {
			throw new DomainError("USAGE keys require limitUsage greater than zero");
		}
		if (data.type === "SUBSCRIPTION" && !data.expiresAt) {
			throw new DomainError("SUBSCRIPTION keys require expiresAt");
		}
		if (data.type !== "SUBSCRIPTION" && data.expiresAt) {
			throw new DomainError("expiresAt is only valid for SUBSCRIPTION keys");
		}

		const expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
		if (
			expiresAt &&
			(Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date())
		) {
			throw new DomainError("expiresAt must be a valid future date");
		}

		return await this.keyRepo.create({
			key: `sk_${Bun.randomUUIDv7()}`,
			userId: data.userId,
			type: data.type,
			limitIp: data.limitIp ?? 0,
			limitHwid: data.limitHwid ?? 0,
			limitConcurrent: data.limitConcurrent ?? 0,
			limitUsage: data.limitUsage ?? 0,
			trialDurationMin: data.trialDurationMin ?? 0,
			firstActivatedAt: null,
			customFields: data.customFields ?? {},
			expiresAt,
		});
	}

	async listKeys(): Promise<ApiKey[]> {
		return await this.keyRepo.findAll();
	}

	async getKey(id: string): Promise<ApiKey> {
		const key = await this.keyRepo.findById(id);
		if (!key) throw new NotFoundError("ApiKey");
		return key;
	}

	async updateKey(id: string, data: UpdateKeyInput): Promise<ApiKey> {
		const current = await this.getKey(id);
		if (Object.keys(data).length === 0) {
			throw new DomainError("At least one license field is required");
		}

		const limits = [
			data.limitIp,
			data.limitHwid,
			data.limitConcurrent,
			data.limitUsage,
			data.trialDurationMin,
		].filter((value): value is number => value !== undefined);
		if (
			limits.some(
				(value) =>
					!Number.isInteger(value) || value < 0 || value > MAX_LICENSE_LIMIT,
			)
		) {
			throw new DomainError(
				`License limits must be non-negative integers no greater than ${MAX_LICENSE_LIMIT}`,
			);
		}

		const userId = data.userId ?? current.userId;
		if (data.userId !== undefined && !(await this.userRepo.findById(userId))) {
			throw new NotFoundError("User");
		}

		const type = data.type ?? current.type;
		const limitUsage = data.limitUsage ?? current.limitUsage;
		if (
			type === "USAGE" &&
			(data.type === "USAGE" || data.limitUsage !== undefined) &&
			limitUsage < 1
		) {
			throw new DomainError("USAGE keys require limitUsage greater than zero");
		}

		let expiresAt = current.expiresAt;
		if (data.expiresAt !== undefined) {
			expiresAt = data.expiresAt === null ? null : new Date(data.expiresAt);
			if (
				expiresAt &&
				(Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date())
			) {
				throw new DomainError("expiresAt must be a valid future date");
			}
		} else if (data.type !== undefined && type !== "SUBSCRIPTION") {
			expiresAt = null;
		}

		if (type === "SUBSCRIPTION" && !expiresAt) {
			throw new DomainError("SUBSCRIPTION keys require expiresAt");
		}
		if (type !== "SUBSCRIPTION" && expiresAt) {
			throw new DomainError("expiresAt is only valid for SUBSCRIPTION keys");
		}

		return await this.keyRepo.update(id, {
			...(data.userId === undefined ? {} : { userId }),
			...(data.type === undefined ? {} : { type }),
			...(data.limitIp === undefined ? {} : { limitIp: data.limitIp }),
			...(data.limitHwid === undefined ? {} : { limitHwid: data.limitHwid }),
			...(data.limitConcurrent === undefined
				? {}
				: { limitConcurrent: data.limitConcurrent }),
			...(data.limitUsage === undefined ? {} : { limitUsage: data.limitUsage }),
			...(data.trialDurationMin === undefined
				? {}
				: { trialDurationMin: data.trialDurationMin }),
			...(data.customFields === undefined
				? {}
				: { customFields: data.customFields }),
			...(data.revoked === undefined ? {} : { revoked: data.revoked }),
			...(data.expiresAt === undefined && data.type === undefined
				? {}
				: { expiresAt }),
		});
	}

	async deleteKey(id: string): Promise<void> {
		await this.getKey(id);
		await this.keyRepo.delete(id);
	}

	async revokeKey(id: string): Promise<ApiKey> {
		await this.getKey(id);
		return await this.keyRepo.update(id, { revoked: true });
	}
}
