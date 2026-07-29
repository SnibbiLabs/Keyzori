import { t } from "elysia";
import { MAX_LICENSE_LIMIT } from "../domain/licenseLimits";

export const KeyTypeSchema = t.Enum(
	{
		PERPETUAL: "PERPETUAL",
		SUBSCRIPTION: "SUBSCRIPTION",
		USAGE: "USAGE",
	},
	{
		description:
			"License model. PERPETUAL has no type-level expiry, SUBSCRIPTION requires expiresAt, and USAGE requires a positive limitUsage balance.",
		examples: ["PERPETUAL", "SUBSCRIPTION", "USAGE"],
	},
);

export const JsonObjectSchema = t.Record(t.String(), t.Unknown(), {
	description: "Application-defined JSON metadata returned after validation.",
	examples: [{ tier: "pro", features: ["export"] }],
});

export const HandshakeInputSchema = t.Object({
	apiKey: t.String({
		minLength: 1,
		maxLength: 128,
		description: "Full license secret returned once when the key is created.",
		examples: ["sk_01900000000000000000000000_example"],
	}),
	hwid: t.String({
		minLength: 1,
		maxLength: 128,
		description: "Stable device identifier. The official SDK generates this.",
		examples: ["sha256-host-identifier"],
	}),
	sessionToken: t.Optional(
		t.String({
			minLength: 32,
			maxLength: 128,
			description:
				"Opaque server-issued token returned by the initial handshake and reused for heartbeats.",
			examples: ["7db7029c-0fe7-42e1-a14b-a14e468b752b"],
		}),
	),
});

export const LogoutInputSchema = t.Object({
	apiKey: t.String({
		minLength: 1,
		maxLength: 128,
		description: "Full license secret used for the session.",
		examples: ["sk_01900000000000000000000000_example"],
	}),
	hwid: t.String({
		minLength: 1,
		maxLength: 128,
		description: "Device identifier bound to the session being released.",
		examples: ["sha256-host-identifier"],
	}),
	sessionToken: t.String({
		minLength: 32,
		maxLength: 128,
		description: "Opaque server-issued token of the session to release.",
		examples: ["7db7029c-0fe7-42e1-a14b-a14e468b752b"],
	}),
});

export const AdminCreateKeyInputSchema = t.Object(
	{
		userId: t.String({
			minLength: 1,
			maxLength: 64,
			description:
				"Required. ID returned by POST /admin/users for the owner of this license.",
			examples: ["01234567-89ab-cdef-0123-456789abcdef"],
		}),
		type: KeyTypeSchema,
		limitIp: t.Optional(
			t.Integer({
				minimum: 0,
				maximum: MAX_LICENSE_LIMIT,
				default: 0,
				examples: [0, 1, 5],
				description:
					"Maximum distinct source IP addresses ever registered to this license. Zero means unlimited; this is not a concurrent-session count.",
			}),
		),
		limitHwid: t.Optional(
			t.Integer({
				minimum: 0,
				maximum: MAX_LICENSE_LIMIT,
				default: 0,
				examples: [0, 1, 3],
				description:
					"Maximum distinct hardware IDs ever registered to this license. Zero means unlimited. The official SDK generates the HWID.",
			}),
		),
		limitConcurrent: t.Optional(
			t.Integer({
				minimum: 0,
				maximum: MAX_LICENSE_LIMIT,
				default: 0,
				examples: [0, 1, 5],
				description:
					"Maximum active server-issued sessions. Zero means unlimited. Sessions expire after 45 seconds unless refreshed by a heartbeat.",
			}),
		),
		limitUsage: t.Optional(
			t.Integer({
				minimum: 0,
				maximum: MAX_LICENSE_LIMIT,
				default: 0,
				examples: [0, 10, 100],
				description:
					"Starting balance for a USAGE license and required to be greater than zero for that type. Each new session consumes one unit; heartbeats do not. Leave zero for other types.",
			}),
		),
		trialDurationMin: t.Optional(
			t.Integer({
				minimum: 0,
				maximum: MAX_LICENSE_LIMIT,
				default: 0,
				examples: [0, 60, 10080],
				description:
					"Optional trial length in minutes for any license type. Timing begins at the first successful handshake. Zero disables the trial.",
			}),
		),
		customFields: t.Optional(
			t.Record(t.String(), t.Unknown(), {
				default: {},
				description:
					"Application-defined JSON returned after every successful validation. Use for plans, features, or tenant data; never store secrets.",
				examples: [{ tier: "pro", features: ["export", "sync"] }],
			}),
		),
		expiresAt: t.Optional(
			t.String({
				format: "date-time",
				description:
					"Future ISO 8601 expiry required for SUBSCRIPTION. Omit for PERPETUAL and USAGE; those types reject this field.",
				examples: ["2027-01-01T00:00:00.000Z"],
			}),
		),
	},
	{
		description:
			"Complete license configuration. Optional limits default to zero, customFields defaults to an empty object, and expiresAt defaults to null.",
		examples: [
			{
				userId: "01234567-89ab-cdef-0123-456789abcdef",
				type: "PERPETUAL",
				limitHwid: 1,
				limitConcurrent: 1,
				customFields: { tier: "pro", features: ["export"] },
			},
			{
				userId: "01234567-89ab-cdef-0123-456789abcdef",
				type: "SUBSCRIPTION",
				expiresAt: "2027-01-01T00:00:00.000Z",
			},
			{
				userId: "01234567-89ab-cdef-0123-456789abcdef",
				type: "USAGE",
				limitUsage: 100,
			},
		],
	},
);

export const AdminUpdateKeyInputSchema = t.Object(
	{
		userId: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
		type: t.Optional(KeyTypeSchema),
		limitIp: t.Optional(t.Integer({ minimum: 0, maximum: MAX_LICENSE_LIMIT })),
		limitHwid: t.Optional(
			t.Integer({ minimum: 0, maximum: MAX_LICENSE_LIMIT }),
		),
		limitConcurrent: t.Optional(
			t.Integer({ minimum: 0, maximum: MAX_LICENSE_LIMIT }),
		),
		limitUsage: t.Optional(
			t.Integer({ minimum: 0, maximum: MAX_LICENSE_LIMIT }),
		),
		trialDurationMin: t.Optional(
			t.Integer({ minimum: 0, maximum: MAX_LICENSE_LIMIT }),
		),
		customFields: t.Optional(t.Record(t.String(), t.Unknown())),
		expiresAt: t.Optional(
			t.Union([t.String({ format: "date-time" }), t.Null()]),
		),
		revoked: t.Optional(t.Boolean()),
	},
	{
		minProperties: 1,
		description:
			"Mutable license fields. Set expiresAt to null when changing away from SUBSCRIPTION.",
	},
);

export const AdminCreateUserInputSchema = t.Object({
	email: t.String({
		format: "email",
		maxLength: 254,
		description: "Unique owner email address. Stored trimmed and lowercase.",
		examples: ["owner@example.com"],
	}),
	name: t.String({
		minLength: 1,
		maxLength: 200,
		description: "Display name for the license owner.",
		examples: ["Example Owner"],
	}),
	customFields: t.Optional(
		t.Record(t.String(), t.Unknown(), {
			default: {},
			description:
				"Operator-defined customer metadata. This is not returned during license handshakes.",
			examples: [{ company: "Acme", accountId: "acct_123" }],
		}),
	),
});

export const AdminUpdateUserInputSchema = t.Object(
	{
		email: t.Optional(
			t.String({
				format: "email",
				maxLength: 254,
				description: "Replacement owner email address.",
			}),
		),
		name: t.Optional(
			t.String({
				minLength: 1,
				maxLength: 200,
				description: "Replacement owner display name.",
			}),
		),
		customFields: t.Optional(
			t.Record(t.String(), t.Unknown(), {
				description: "Replacement operator-defined customer metadata.",
			}),
		),
	},
	{ minProperties: 1 },
);

export const UserResponseSchema = t.Object({
	id: t.String({ description: "Internal owner ID." }),
	email: t.String({ format: "email" }),
	name: t.String(),
	customFields: JsonObjectSchema,
	createdAt: t.Date(),
});

export const ApiKeyResponseSchema = t.Object({
	id: t.String({
		description: "Internal key ID used by administrative routes.",
	}),
	key: t.String({
		description:
			"Full secret at creation time; masked prefix in later responses. Store a newly created secret immediately.",
		examples: ["sk_01900000000000000000000000_example"],
	}),
	userId: t.String({
		description: "ID of the owner associated with this key.",
	}),
	type: KeyTypeSchema,
	limitIp: t.Integer({
		minimum: 0,
		maximum: MAX_LICENSE_LIMIT,
		description: "Maximum registered IP addresses; zero is unlimited.",
	}),
	limitHwid: t.Integer({
		minimum: 0,
		maximum: MAX_LICENSE_LIMIT,
		description: "Maximum registered devices; zero is unlimited.",
	}),
	limitConcurrent: t.Integer({
		minimum: 0,
		maximum: MAX_LICENSE_LIMIT,
		description: "Maximum concurrent sessions; zero is unlimited.",
	}),
	limitUsage: t.Integer({
		minimum: 0,
		maximum: MAX_LICENSE_LIMIT,
		description: "Remaining usage allowance.",
	}),
	trialDurationMin: t.Integer({
		minimum: 0,
		maximum: MAX_LICENSE_LIMIT,
		description: "Trial duration in minutes; zero disables the trial.",
	}),
	firstActivatedAt: t.Nullable(
		t.Date({
			description: "First successful handshake, or null before activation.",
		}),
	),
	customFields: JsonObjectSchema,
	expiresAt: t.Nullable(
		t.Date({
			description: "Subscription expiry, or null when not applicable.",
		}),
	),
	revoked: t.Boolean({ description: "Whether new handshakes are rejected." }),
	createdAt: t.Date(),
});

export const ErrorResponseSchema = t.Object({
	error: t.String({
		description: "Safe, human-readable error message.",
		examples: ["Invalid or revoked API key"],
	}),
	code: t.Enum(
		{
			INVALID_REQUEST: "INVALID_REQUEST",
			UNAUTHORIZED: "UNAUTHORIZED",
			NOT_FOUND: "NOT_FOUND",
			CONFLICT: "CONFLICT",
			RATE_LIMITED: "RATE_LIMITED",
			INTERNAL_ERROR: "INTERNAL_ERROR",
			LICENSE_INVALID_OR_REVOKED: "LICENSE_INVALID_OR_REVOKED",
			IP_NOT_WHITELISTED: "IP_NOT_WHITELISTED",
			HWID_NOT_WHITELISTED: "HWID_NOT_WHITELISTED",
			TRIAL_EXPIRED: "TRIAL_EXPIRED",
			SUBSCRIPTION_EXPIRED: "SUBSCRIPTION_EXPIRED",
			SESSION_INVALID_OR_EXPIRED: "SESSION_INVALID_OR_EXPIRED",
			CONCURRENT_SESSION_LIMIT: "CONCURRENT_SESSION_LIMIT",
			USAGE_EXHAUSTED: "USAGE_EXHAUSTED",
			IP_REGISTRATION_LIMIT: "IP_REGISTRATION_LIMIT",
			HWID_REGISTRATION_LIMIT: "HWID_REGISTRATION_LIMIT",
		},
		{
			description:
				"Stable machine-readable error identifier. Clients should branch on this value rather than the message.",
		},
	),
});

export const HandshakeResponseSchema = t.Object(
	{
		success: t.Literal(true),
		type: KeyTypeSchema,
		customFields: JsonObjectSchema,
		sessionToken: t.String({
			description: "Opaque token used for heartbeats and logout.",
		}),
		sessionTtlSeconds: t.Integer({
			minimum: 1,
			description:
				"Server-side session lifetime. Heartbeats must run safely within this window.",
		}),
	},
	{
		description: "Accepted license and application-defined metadata.",
	},
);

export const SuccessResponseSchema = t.Object({
	success: t.Literal(true),
});
