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

- Admin status, connection create/test, both imports and publishes, service access, and scoped journey-key creation;
- Esri migration through `honua_esri_gp_list_tasks`, `honua_esri_gp_describe_task`, and
  `honua_esri_gp_execute_task`, followed by the advertised job and results resources;
- the direct `GPServer/analysis/Buffer` SDK action and the native `honua_buffer_features` job/resources;
- separate map, app, and dashboard calls for create, every planned layer, style, visibility, view, widget, control,
  app interaction binding, validate, save, get, reopen, and propose-publication. Action ids, order, and multiplicity
  must equal the canonical SDK plan; unaccounted actions are a refusal.

MCP schemas advertised by the server remain authoritative. The two synthetic model tools are limited to the
SDK-owned `mcp-resource` and `gpserver` action shapes; they do not translate or duplicate a server tool.

## Console boundary

The `prepare` phase writes a sealed, immutable
`honua.studio.real-model-ai-arc-handoff/v1` document to `HONUA_AI_ARC_REAL_MODEL_HANDOFF` and a separate
`honua.studio.real-model-ai-arc-transcript/v1` artifact to `HONUA_AI_ARC_REAL_MODEL_TRANSCRIPT`, writes no passed
evidence or receipt, prints the handoff requirement, and exits 2. The handoff binds the exact transcript artifact
bytes by SHA-256. Exclusive claims prevent concurrent producers; an existing handoff is accepted only after the
transcript bytes, prompts, parsed model events, selected response, and per-lane/call digests are revalidated without
re-running the model.
Console is the only component allowed to approve the map,
app, and dashboard proposals and return their publication/audit identities and HTTPS public links.

Run the explicit `resume` phase after Console writes both its strict three-family SDK aggregate and the separate
`honua.console.ai-arc-evidence/v1` sidecar. Resume requires the immutable handoff and is credential-free: it cannot
contact the model, Admin API, or replay a deterministic action. It exact-validates the handoff roster/joins, hashes
of the aggregate and sidecar, checkpoint/endpoint/component bindings, and Console-observed approval/publication/
audit/recovery facts. It then independently reads public `/api/v1/capabilities`, `/version.json`, and all three
publication URLs before writing transcript-level evidence and the passed receipt. The sidecar has a canonical
SHA-256 integrity digest; this is a corruption/source binding claim, not a cryptographic signature. DevOps performs
its own privileged audit revalidation.

- AWS ECS: `honua.aws-ecs.real-model-ai-arc-evidence/v1` and
  `honua.aws-ecs.real-model-ai-arc/v1`, byte-compatible with honua-devops PR #149 at
  `c5806b7ad352c63b63f3b1ec55c9e52e6e9e0de8`;
- local Docker: `honua.local-docker.real-model-ai-arc-evidence/v1` and
  `honua.local-docker.real-model-ai-arc/v1` with id `local-docker-real-model-ai-arc`. The receipt carries the same
  detailed model, lane, join, check, component, and content-addressed evidence shape as AWS, with the local target,
  local prompt/eval versions, and deterministic checkpoint/Console aggregate/Console sidecar hashes required by
  honua-release PR #160.

The transcript artifact serializes the exact generated prompts, canonical parsed model events, and selected
responses needed to verify every response, prompt, transcript, lane, and aggregate digest. It is a private
certification artifact written mode 0600, not public release content. The model never receives the Admin credential
(it is sent only as an HTTP authorization header), resolved SDK secret inputs remain redacted credential references,
and provider secrets are never serialized. A credential-looking evidence key makes the producer refuse the output.

## Required environment

| Variable | Purpose |
| --- | --- |
| `HONUA_PLATFORM_MANIFEST` | Exact candidate `platform-manifest.yaml` bytes. |
| `HONUA_AI_ARC_SDK_PLAN` | Manifest-pinned SDK `mcp/release/zero-to-map/journey.v1.json`. |
| `HONUA_AI_ARC_CHECKPOINT` | Sealed deterministic SDK Console-pause checkpoint. |
| `HONUA_AI_ARC_ENDPOINT` | Credential-free HTTPS Honua origin; `/mcp` and `/api/v1/studio/ai/chat` are derived. |
| `HONUA_AI_ARC_CONSOLE_ORIGIN` | Credential-free HTTPS Console origin; resume independently verifies `/version.json.commit`. |
| `HONUA_AI_ARC_PROVISION_BINDING` | Required for AWS ECS; exact provision receipt bound by the checkpoint. |
| `HONUA_AI_ARC_CONSOLE_RECEIPT` | Strict SDK-owned three-family Console aggregate required by Studio resume. |
| `HONUA_AI_ARC_SDK_CONSOLE_RECEIPT` | Distinct path containing a byte-identical copy of the strict three-family SDK aggregate for deterministic SDK resume. |
| `HONUA_AI_ARC_CONSOLE_EVIDENCE` | Console-owned `honua.console.ai-arc-evidence/v1` sidecar, digest-bound to the aggregate and handoff. |
| `HONUA_AI_ARC_REAL_MODEL_HANDOFF` | Immutable prepare-phase handoff consumed by Console and Studio resume. |
| `HONUA_AI_ARC_REAL_MODEL_TRANSCRIPT` | Immutable prompt/model-event/selected-response artifact, byte-bound by the handoff and final receipt. |
| `HONUA_AI_ARC_REAL_MODEL_EVIDENCE` | Final transcript evidence output; never used as the mutable handoff path. |
| `HONUA_AI_ARC_REAL_MODEL_RECEIPT` | Final passed receipt output; never written before Console. |
| `HONUA_AI_ARC_EVIDENCE_URL` | Credential-free HTTPS publication location for the final evidence bytes. |
| `HONUA_AI_PROVIDER` | `anthropic`, `bedrock`, or `openai`. |
| `HONUA_AI_MODEL` | Requested model identity; the server-returned identity must remain stable for every call. |
| `HONUA_AI_ARC_PREPARE_CREDENTIAL` | Purpose-specific least-privilege model/MCP catalog credential, read only during `prepare`. Broad `HONUA_ADMIN_KEY`/`HONUA_API_KEY` variables are refused. |

Unset every credential variable before `resume`. Final evidence and receipt use exclusive 0600 temporary files,
atomic links, immutable occupied-coordinate equality checks, and a digest-bound lease claim. A retry verifies
matching outputs and repairs a missing half of the evidence/receipt pair; it never overwrites differing bytes.

## Candidate binding

The producer is locally covered with a mocked transport and does not claim live evidence. SDK PR #1375 exact head
`5d5483f155fe4e7774a9c29dc2686031d6971dac` owns the full action roster and the credential-free, public-HTTPS
fixture source needed to resume it. Its canonical
`mcp/release/zero-to-map/journey.v1.json` SHA-256 is
`4358e1c03a56f0cc8996133a608f421a5d9828cb8462a458983eab635348a1fe`; both identities are hard gates. The
running Studio source is always `git rev-parse HEAD`, must have no tracked worktree/index changes, and must equal
the manifest pin; there is no environment override. An open PR head or local mock is not a release candidate and
cannot produce a passed receipt.

The browser currently consumes the occupied `@honua/sdk-js@0.1.7-beta.0` package for development compatibility,
but that registry coordinate was built from an older commit and cannot satisfy release. `npm run release:verify-sdk`
fails closed until an immutable new SDK version is published from exact head `5d5483f1...`, Studio pins that version
and lock integrity, and the public npm metadata reports the exact git head. The release workflow runs this gate
before any container or GitHub Release publication. Its governance preflight also refuses to enter a missing or
bypassable `production` environment: an owner must configure a required reviewer, disable administrator bypass,
and allow only the custom `v*` tag deployment policy. This prevents GitHub from silently auto-creating an
unprotected environment on the first release run.
