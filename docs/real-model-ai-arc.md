# Candidate-bound real-model AI arc

`npm run release:real-model-ai-arc -- prepare --execute --yes` and
`npm run release:real-model-ai-arc -- resume --execute --yes` are the Studio-owned producer phases for the 2026.1
“install Honua, configure and publish services, run GP, then create and share maps/apps/dashboards with AI”
release arc. It works with an HTTPS local-Docker endpoint or the provisioned AWS ECS endpoint. It is a
release-evidence producer, not a fixture/demo runner.

The producer consumes the exact platform manifest, the manifest-pinned SDK journey plan, and the sealed SDK
checkpoint paused at `console/console-approval`. It discovers MCP schemas from the candidate endpoint and asks
the configured real model to select each exact already-passed SDK operation. The selected name and arguments
must exactly equal the SDK action after checkpoint substitution. The producer reconciles those model turns to
the SDK action receipts instead of replaying mutations and creating a second connection, service, GP job, draft,
or publication proposal.

The governed roster covers:

- Admin status, connection create/test, both imports and publishes, and service access;
- Esri migration through `honua_esri_gp_list_tasks`, `honua_esri_gp_describe_task`, and
  `honua_esri_gp_execute_task`, followed by the advertised job and results resources;
- the direct `GPServer/analysis/Buffer` SDK action and the native `honua_buffer_features` job/resources;
- separate map, app, and dashboard calls for create, add layer, style, view, widget, control, validate, save,
  get, reopen, and propose-publication.

MCP schemas advertised by the server remain authoritative. The two synthetic model tools are limited to the
SDK-owned `mcp-resource` and `gpserver` action shapes; they do not translate or duplicate a server tool.

## Console boundary

The `prepare` phase writes a sealed
`honua.studio.real-model-ai-arc-handoff/v1` document to `HONUA_AI_ARC_REAL_MODEL_EVIDENCE`, writes no passed
receipt, prints the handoff requirement, and exits 2. It refuses to overwrite any existing evidence or receipt.
Console is the only component allowed to approve the map,
app, and dashboard proposals and return their publication/audit identities and HTTPS public links.

Run the explicit `resume` phase after Console writes its receipt. Resume requires the existing sealed handoff and
cannot contact the model or replay a deterministic action. It verifies the checkpoint's pointer matches,
required fields, equality joins, candidate identity, and HTTPS URLs. It then replaces the paused handoff with
transcript-level evidence and writes the passed receipt:

- AWS ECS: `honua.aws-ecs.real-model-ai-arc-evidence/v1` and
  `honua.aws-ecs.real-model-ai-arc/v1`, byte-compatible with honua-devops PR #149 at
  `3fc229d3ed19fb5e1cccf33ee95a837f407e6037`;
- local Docker: `honua.studio.real-model-ai-arc-evidence/v1` and the
  `honua.release.evidence-receipt/v1` `studio-real-model` receipt consumed by honua-release PR #160.

Only response, prompt, transcript, checkpoint, endpoint, and evidence hashes plus scalar identity joins are
serialized. Raw prompts/model events, tool payloads, credentials, and provider secrets remain in memory. A
credential-looking evidence key makes the producer refuse the output.

## Required environment

| Variable | Purpose |
| --- | --- |
| `HONUA_PLATFORM_MANIFEST` | Exact candidate `platform-manifest.yaml` bytes. |
| `HONUA_AI_ARC_SDK_PLAN` | Manifest-pinned SDK `mcp/release/zero-to-map/journey.v1.json`. |
| `HONUA_AI_ARC_CHECKPOINT` | Sealed deterministic SDK Console-pause checkpoint. |
| `HONUA_AI_ARC_ENDPOINT` | Credential-free HTTPS Honua origin; `/mcp` and `/api/v1/studio/ai/chat` are derived. |
| `HONUA_AI_ARC_PROVISION_BINDING` | Required for AWS ECS; exact provision receipt bound by the checkpoint. |
| `HONUA_AI_ARC_CONSOLE_RECEIPT` | Scoped three-family Console aggregate required by Studio resume. |
| `HONUA_AI_ARC_SDK_CONSOLE_RECEIPT` | App-focused SDK projection; consumed only by the deterministic SDK resume. |
| `HONUA_AI_ARC_REAL_MODEL_EVIDENCE` | Paused handoff, then final transcript evidence output. |
| `HONUA_AI_ARC_REAL_MODEL_RECEIPT` | Final passed receipt output; never written before Console. |
| `HONUA_AI_ARC_EVIDENCE_URL` | Credential-free HTTPS publication location for the final evidence bytes. |
| `HONUA_AI_PROVIDER` | `anthropic`, `bedrock`, or `openai`. |
| `HONUA_AI_MODEL` | Requested model identity; the server-returned identity must remain stable for every call. |
| `HONUA_ADMIN_KEY` or `HONUA_API_KEY` | Scoped HTTPS/MCP credential, used only in request headers. |
| `HONUA_AI_ARC_SOURCE_SHA` | Optional producer SHA; otherwise `git rev-parse HEAD`. Must equal the Studio pin. |

## Candidate binding

The producer is locally covered with a mocked transport and does not claim live evidence. SDK PR #1375 head
`c11668ee47d28ccd65e64b5c9e7179e1422d74f5` owns the full per-family action roster and seeds only the
plan-owned `serviceName` into checkpoint captures with resume-time tamper rejection. The producer was audited
against that exact source. It still refuses until the platform manifest pins that SDK SHA and the Studio SHA
containing this producer; an open PR head or local mock is not a release candidate and cannot produce a passed
receipt.
