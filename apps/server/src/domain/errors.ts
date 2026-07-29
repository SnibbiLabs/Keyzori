export type ApiErrorCode =
	| "INVALID_REQUEST"
	| "UNAUTHORIZED"
	| "NOT_FOUND"
	| "CONFLICT"
	| "RATE_LIMITED"
	| "INTERNAL_ERROR"
	| "LICENSE_INVALID_OR_REVOKED"
	| "IP_NOT_WHITELISTED"
	| "HWID_NOT_WHITELISTED"
	| "TRIAL_EXPIRED"
	| "SUBSCRIPTION_EXPIRED"
	| "SESSION_INVALID_OR_EXPIRED"
	| "CONCURRENT_SESSION_LIMIT"
	| "USAGE_EXHAUSTED"
	| "IP_REGISTRATION_LIMIT"
	| "HWID_REGISTRATION_LIMIT";

export class DomainError extends Error {
	constructor(
		message: string,
		public statusCode: number = 400,
		public code: ApiErrorCode = "INVALID_REQUEST",
	) {
		super(message);
		this.name = this.constructor.name;
	}
}
export class NotFoundError extends DomainError {
	constructor(resource: string) {
		super(`${resource} not found`, 404, "NOT_FOUND");
	}
}

export class ConflictError extends DomainError {
	constructor(message: string) {
		super(message, 409, "CONFLICT");
	}
}
