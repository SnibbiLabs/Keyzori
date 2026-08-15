import { timingSafeEqual } from "node:crypto";
import {
	DashboardHttpError,
	type DashboardConfig,
	type DashboardRedis,
} from "./types";

interface StoredSession {
	csrfToken: string;
	expiresAt: number;
}

const LOGIN_ATTEMPT_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return { count, redis.call("TTL", KEYS[1]) }
`;

const SESSION_PREFIX = "keyzori:dashboard:session:";
const LOGIN_PREFIX = "keyzori:dashboard:login:";

function digest(value: string): Uint8Array {
	return new Bun.CryptoHasher("sha256").update(value).digest();
}

function digestHex(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function randomToken(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
		"base64url",
	);
}

function cookieValue(request: Request, name: string): string | null {
	const header = request.headers.get("cookie");
	if (!header) return null;
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator === -1) continue;
		if (part.slice(0, separator).trim() === name) {
			return part.slice(separator + 1).trim() || null;
		}
	}
	return null;
}

function numberAt(value: unknown, index: number): number {
	if (!Array.isArray(value)) return 0;
	const parsed = Number(value[index]);
	return Number.isFinite(parsed) ? parsed : 0;
}

function parseRedisString(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value instanceof Uint8Array) return new TextDecoder().decode(value);
	return null;
}

function validCredential(expected: Uint8Array, supplied: string): boolean {
	return timingSafeEqual(expected, digest(supplied));
}

export interface DashboardLoginResult {
	cookie: string;
	csrfToken: string;
}

export class RedisDashboardSessions {
	private readonly usernameDigest: Uint8Array;
	private readonly passwordDigest: Uint8Array;
	private readonly cookieName: string;
	private readonly sessionTtlSeconds: number;
	private readonly loginWindowSeconds: number;
	private readonly maxLoginAttempts: number;

	constructor(
		private readonly redis: DashboardRedis,
		config: DashboardConfig,
		private readonly now: () => number = Date.now,
	) {
		const username = config.username.trim();
		if (!username) {
			throw new Error("Dashboard username must be configured.");
		}
		if (!config.password || config.password.length < 16) {
			throw new Error("Dashboard password must be at least 16 characters.");
		}
		this.usernameDigest = digest(username);
		this.passwordDigest = digest(config.password);
		this.cookieName = config.secureCookies
			? "__Host-keyzori_dashboard_session"
			: "keyzori_dashboard_session";
		this.sessionTtlSeconds = config.sessionTtlMinutes * 60;
		this.loginWindowSeconds = config.loginWindowSeconds ?? 15 * 60;
		this.maxLoginAttempts = config.maxLoginAttempts ?? 5;
		if (this.sessionTtlSeconds < 300 || this.sessionTtlSeconds > 86_400) {
			throw new Error(
				"Dashboard session TTL must be between 300 and 86400 seconds.",
			);
		}
		if (this.loginWindowSeconds < 60 || this.loginWindowSeconds > 3_600) {
			throw new Error(
				"Dashboard login window must be between 60 and 3600 seconds.",
			);
		}
		if (this.maxLoginAttempts < 1 || this.maxLoginAttempts > 20) {
			throw new Error(
				"Dashboard maximum login attempts must be between 1 and 20.",
			);
		}
	}

	async login(
		username: string,
		password: string,
		clientId: string,
	): Promise<DashboardLoginResult> {
		const failureKey = `${LOGIN_PREFIX}${digestHex(clientId)}`;
		const reservation = await this.redis.send("EVAL", [
			LOGIN_ATTEMPT_SCRIPT,
			"1",
			failureKey,
			String(this.loginWindowSeconds),
		]);
		const attempts = numberAt(reservation, 0);
		const retryAfter = Math.max(1, numberAt(reservation, 1));
		if (attempts > this.maxLoginAttempts) {
			throw new DashboardHttpError(
				429,
				`Too many login attempts. Try again in ${retryAfter} seconds.`,
			);
		}

		const usernameValid = validCredential(this.usernameDigest, username.trim());
		const passwordValid = validCredential(this.passwordDigest, password);
		if (!usernameValid || !passwordValid) {
			throw new DashboardHttpError(401, "Authentication failed.");
		}

		await this.redis.send("DEL", [failureKey]);
		const token = randomToken();
		const csrfToken = randomToken();
		const session: StoredSession = {
			csrfToken,
			expiresAt: this.now() + this.sessionTtlSeconds * 1_000,
		};
		await this.redis.send("SET", [
			`${SESSION_PREFIX}${digestHex(token)}`,
			JSON.stringify(session),
			"EX",
			String(this.sessionTtlSeconds),
		]);
		return {
			cookie: this.serializeCookie(token, this.sessionTtlSeconds),
			csrfToken,
		};
	}

	async session(request: Request): Promise<StoredSession | null> {
		const token = cookieValue(request, this.cookieName);
		if (token?.length !== 43) return null;
		const key = `${SESSION_PREFIX}${digestHex(token)}`;
		const raw = parseRedisString(await this.redis.send("GET", [key]));
		if (!raw) return null;
		try {
			const parsed = JSON.parse(raw) as Partial<StoredSession>;
			if (
				typeof parsed.csrfToken !== "string" ||
				parsed.csrfToken.length !== 43 ||
				typeof parsed.expiresAt !== "number" ||
				parsed.expiresAt <= this.now()
			) {
				await this.redis.send("DEL", [key]);
				return null;
			}
			return parsed as StoredSession;
		} catch {
			await this.redis.send("DEL", [key]);
			return null;
		}
	}

	async verifyCsrf(request: Request): Promise<boolean> {
		const token = request.headers.get("x-csrf-token");
		if (token?.length !== 43) return false;
		const session = await this.session(request);
		return session ? validCredential(digest(session.csrfToken), token) : false;
	}

	async logout(request: Request): Promise<string> {
		const token = cookieValue(request, this.cookieName);
		if (token) {
			await this.redis.send("DEL", [`${SESSION_PREFIX}${digestHex(token)}`]);
		}
		return this.serializeCookie("", 0);
	}

	private serializeCookie(value: string, ttlSeconds: number): string {
		const parts = [
			`${this.cookieName}=${value}`,
			"Path=/",
			"HttpOnly",
			"SameSite=Strict",
			"Priority=High",
			`Max-Age=${ttlSeconds}`,
		];
		if (this.cookieName.startsWith("__Host-")) parts.push("Secure");
		return parts.join("; ");
	}
}

export function isSameOriginMutation(request: Request): boolean {
	if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) {
		return true;
	}
	const origin = request.headers.get("origin");
	if (!origin || request.headers.get("sec-fetch-site") === "cross-site") {
		return false;
	}
	try {
		const originUrl = new URL(origin);
		const requestHost =
			request.headers.get("host") ?? new URL(request.url).host;
		return (
			(originUrl.protocol === "https:" || originUrl.protocol === "http:") &&
			originUrl.host === requestHost
		);
	} catch {
		return false;
	}
}
