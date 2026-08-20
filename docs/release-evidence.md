# 2026.1 release evidence

| Capability | Repository evidence | External receipt |
| --- | --- | --- |
| Static release bundle | `npm run build`; CI artifact | Available when a version tag runs the release workflow |
| Non-root container/runtime config | `Dockerfile`, `docker/`, runtime-config tests | Container smoke in CI |
| Live AI turn loop | SDK `StudioAgentSession` wiring and mocked turn tests | Blocked on honua-server#3303 provider auth |
| Durable draft restart | Client reconciliation tests | Blocked on honua-server#3312 |
| Human-approved share link | Lifecycle/mock contract tests | Blocked on honua-server#3304 |
| Hosted demo | No claim | Non-blocking; schedule after server gates and operator credentials |

Do not convert a local mock result into a live-server or hosted-demo claim.
