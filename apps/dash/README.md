# Keyzori dashboard

A small, standalone Elysia dashboard for server operators. It provides full CRUD for customers and licenses, including independent JSON custom fields for each, without connecting to PostgreSQL or Redis. Every data operation goes through the Keyzori admin HTTP API.

## Configure

Copy `.env.example` to `.env` and set:

| Variable | Required | Purpose |
| --- | --- | --- |
| `KEYZORI_SERVER_URL` | Yes | Keyzori server origin. HTTPS is required outside loopback unless the explicit private-network override is enabled. |
| `KEYZORI_AUTH_PASS` | Yes | Unique dashboard login password of at least 16 characters. |
| `KEYZORI_ADMIN_KEY` | Yes | The server's `ADMIN_API_KEY`; at least 32 characters and different from the login password. |
| `HOST` | No | Bind address. Defaults to `0.0.0.0`. |
| `PORT` | No | Listen port. Defaults to `3100`. |
| `KEYZORI_SECURE_COOKIES` | No | Secure-cookie and HSTS policy. Defaults to `true`; set `false` only for local HTTP development. |
| `KEYZORI_SESSION_TTL_MINUTES` | No | Fixed server-side session lifetime, 5–1440 minutes. Defaults to `480`. |
| `KEYZORI_UPSTREAM_TIMEOUT_MS` | No | API request deadline, 1000–60000 ms. Defaults to `10000`. |
| `KEYZORI_ALLOW_INSECURE_SERVER` | No | Allows an HTTP API URL outside loopback. Use only on a trusted private network. |

The dashboard exits before listening when required configuration is missing, weak, or unsafe.

## Operator behavior

- Customers and licenses support full create, read, update, and delete operations through the API.
- Customer custom fields are operator-only metadata. License custom fields are returned to licensed applications by the handshake and SDK.
- Custom fields use key/value rows. Plain values remain strings; valid JSON values such as numbers, booleans, arrays, objects, and `null` keep their types.
- The full license secret is returned only at creation. The dashboard keeps a newly created secret blurred and copyable in the current tab, but clears it on reload or sign-out. Existing licenses display only their non-secret prefix because the server stores a hash.

## Run

From the repository root:

```powershell
Copy-Item apps/dash/.env.example apps/dash/.env
bun install --frozen-lockfile
bun run dash
```

Open `http://localhost:3100`. For local HTTP, set `KEYZORI_SECURE_COOKIES=false`; production deployments should terminate TLS and keep the default.

The folder can also be deployed by itself:

```powershell
docker build --file apps/dash/Dockerfile --tag keyzori-dashboard .
docker run --env-file apps/dash/.env --publish 3100:3100 keyzori-dashboard
```

The root build context supplies centralized workspace dependencies, but the resulting dashboard container remains an independent service.

## Security model

- The browser receives only an opaque, random, `HttpOnly`, `SameSite=Strict` session cookie. Sessions are stored in memory and expire after a fixed lifetime, so a restart signs everyone out.
- Login comparison and server admin-key comparison use constant-time digest checks. Five failed logins from one TCP peer cause a 15-minute lockout.
- Mutating requests require an exact same-origin `Origin`; cross-site requests are rejected before proxying.
- The upstream admin key remains server-side. The proxy exposes only an allowlisted set of customer and license endpoints, rejects redirects and non-JSON responses, and applies response-size and timeout limits. Responses are streamed through a 2 MiB reader and cancelled immediately when that ceiling is crossed.
- CSP, frame denial, no-sniff, no-referrer, permissions policy, no-store, and HSTS headers are applied centrally.
- Keep the dashboard behind TLS, restrict network access where possible, and never reuse `KEYZORI_AUTH_PASS` as `KEYZORI_ADMIN_KEY`.

In-memory sessions are intentionally simple and fit a single small deployment. Running multiple replicas requires sticky sessions or a shared session store.

## Validate

```powershell
bun run typecheck
bun test
```
