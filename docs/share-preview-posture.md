# Sharing: Preview and graduation posture

Studio preserves the server's publication separation of duties. An agent or
browser session may submit publication intent, but it must never execute
publish, share, or embed directly or approve its own proposal.

## 2026.1 Preview gate

For the 2026.1 browser Preview, sharing is qualified by a smoke against the GA
server that verifies the existing server-owned contract:

1. a saved immutable version can be submitted through the canonical proposal
   API;
2. the server returns a proposal handle and a pending state;
3. the client cannot turn that proposal into published state without a separate
   human principal; and
4. an approved fixture proposal resolves to the server-issued working URL.

The smoke may use deterministic, separately scoped test principals. It must not
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
