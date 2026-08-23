# 2026.1 release evidence

The candidate-bound real-model producer and its focused Console pause/resume contract are documented in
[real-model-ai-arc.md](./real-model-ai-arc.md). Its receipts are separate from the deterministic browser receipts
below: mocked CI verifies the producer contract, while only an exact candidate endpoint and real provider may
produce release evidence.

| Capability | Repository evidence | External receipt |
| --- | --- | --- |
| Static release bundle | `npm run build`; CI artifact | Available when a version tag runs the release workflow |
| Non-root container/runtime config | `Dockerfile`, `docker/`, runtime-config tests | Container smoke in CI |
| Live AI turn loop | SDK `StudioAgentSession` wiring and mocked turn tests | Blocked on honua-server#3303 provider auth |
| Durable draft restart | Client reconciliation tests | Blocked on honua-server#3312 |
| Human-approved share link | Lifecycle/mock contract tests | Blocked on honua-server#3304 |
| Hosted demo | No claim | Non-blocking; schedule after server gates and operator credentials |

Do not convert a local mock result into a live-server or hosted-demo claim.

For a tag-push release, the checked-out tag commit must equal both the live tag
target and the immutable `GITHUB_SHA` recorded by the push event. Static archive
timestamps and BuildKit image timestamps are clamped to the source commit's
`SOURCE_DATE_EPOCH`. Both CI and the release transaction perform two no-cache
image builds from that epoch and require the same `RootFS.Layers` plus image
`Config` fingerprint used by the occupied-coordinate retry gate.
