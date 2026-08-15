# Runtime flow

The license secret is used once to activate. All later requests use the server-issued session token.

```mermaid
sequenceDiagram
    participant App as Licensed application
    participant API as Keyzori server
    participant DB as PostgreSQL
    participant Redis

    App->>API: POST /v1/activate (licenseKey, deviceId)
    API->>DB: Load license, status, allowlists, registrations
    API->>DB: Serialize registration; compare-and-set trial start
    API->>Redis: Admit bound session within maxSessions
    API-->>App: sessionToken, TTL, licenseType, metadata

    loop Before session TTL expires
        App->>API: POST /v1/heartbeat (sessionToken, deviceId)
        API->>Redis: Resolve and refresh bound session
        API->>DB: Re-check current license policy
        API-->>App: TTL, licenseType, metadata
    end

    opt Application reports metered work
        App->>API: POST /v1/usage (sessionToken, meter, units, eventId)
        API->>DB: Atomic idempotent debit and ledger insert
        API-->>App: remaining balance
    end

    App->>API: POST /v1/deactivate (sessionToken, deviceId)
    API->>Redis: Remove bound session
```

## Validation order

Activation validates the secret, effective status, allowlists, trial start, registration limits, and concurrency before returning a token. Heartbeat and usage first resolve the token and its IP/device binding, then reload the license so type changes, expiry, revocation, and allowlist edits apply immediately.

Heartbeat never consumes a meter. A usage report is accepted only for a `metered` license and performs its idempotency check, balance check, debit, and ledger write atomically.

Runtime attempts and outcomes are recorded around the licensing decision. Telemetry persistence failures are isolated from successful license operations. Live dashboard events omit exact IP and device identifiers; those values are available only in the protected per-license access view.
