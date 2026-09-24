# Sharing: Preview and graduation posture

Studio preserves the server's publication separation of duties. Agent-controlled
chat and MCP paths may submit publication intent, but they must never execute
publish, share, or embed directly. Publication remains reachable only through
the lifecycle panel's explicit human confirmation flow.

## 2026.1 Preview gate

For the 2026.1 browser Preview, sharing is qualified by a smoke against the GA
server that verifies the existing two-stage, server-owned contract:

1. the canonical proposal MCP tool records publication intent on a mutable
   draft and returns `recorded` plus `humanConfirmationRequired`;
2. the draft can be saved as an immutable version carrying that intent;
3. agent-controlled paths cannot call the publish-request API, while an explicit
   lifecycle-panel confirmation can submit that immutable version; and
4. an accepted fixture publish request moves the server-owned published pointer
   and resolves to the server-issued working URL.

The smoke may use deterministic, separately scoped test principals when the GA
server configuration requires them. It must not
add an agent-executable publication exception or a second sharing model. A
real-model turn, hosted demo, polished proposal UI, and unattended end-to-end
approval journey do not gate the 2026.1 Preview.

## 2026.2 graduation checklist

Before Studio graduates from Preview:

- a conversational share request produces a visible pending proposal;
- the proposal handle survives reload and the session polls or subscribes via
  the released SDK contract;
- approval or rejection by a separate human principal is reflected in the
  conversation, and approval returns a verified working link;
- owner/RBAC, audit/correlation, generation, and separation-of-duties behavior
  matches the terminal and Console clients;
- restart and cross-replica qualification proves the proposal and published
  version are durable;
- the private-versus-public scope decision is recorded explicitly; and
- release receipts bind the Studio, SDK, and GA-server revisions exercised by
  the full browser journey.
