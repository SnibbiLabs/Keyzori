# Keyzori documentation

Keyzori is a self-hosted license server for software products. The dashboard is exclusively for developers operating an instance; licensed product users do not receive Keyzori accounts or key-management access.

## Guides

| Topic | Guide |
| --- | --- |
| Install or deploy | [Deployment](deployment.md) |
| Configure server, dashboard, and Stripe | [Configuration](configuration.md) |
| Understand the four types and limits | [Licensing model](licensing-model.md) |
| Integrate an application | [SDK reference](sdk-reference.md) |
| Call HTTP directly | [API reference](api-reference.md) |
| Administer from the container | [CLI reference](cli-reference.md) |
| Follow activation and session behavior | [Runtime flow](runtime-flow.md) |
| Understand components and storage | [Architecture](architecture.md) |
| Operate and monitor production | [Operations](operations.md) |
| Diagnose common failures | [Troubleshooting](troubleshooting.md) |

## Core vocabulary

- A `Customer` is an operator-managed record that owns licenses.
- A `License` contains type policy, limits, access rules, and client-visible `metadata`.
- The full `licenseKey` is a secret shown only after creation or rotation; later views use `keyPrefix`.
- A `deviceId` is the stable, hashed application/device identity used for registration and session binding.
- A named meter records explicit, idempotent usage for a `metered` license.

Start with the repository [quick start](../README.md#quick-start), then use the dashboard at `/` on port `3000` or `keyzori admin` to create the first customer and license.
