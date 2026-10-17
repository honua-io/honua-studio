# Sharing: Preview and graduation posture

Studio sharing in 2026.1 is Preview. It is not GA. This page describes the
**browser Preview adapter and its non-admin fixture journey**, not every server
MCP outcome. The current server's
[publication tool](https://github.com/honua-io/honua-server/blob/trunk/docs/studio/mcp-tools.md)
can publish directly for an authorized admin and return `Published` with a
`shareUrl`. The browser's `ProposeStudioPublicationOutput` and share-preview
handler currently model `AwaitingApproval` only; support for the direct result
remains an implementation gap. Do not infer universal server policy from this
fixture or report an unhandled result as a pending proposal.

Within this browser adapter, agent-controlled chat and MCP paths submit a canonical publication proposal for an already-saved
immutable version, but they must never execute publish, share, or embed.
Private and public visibility both stay `AwaitingApproval` until a different
principal decides. There is no agent-executable private-link exception.

The lifecycle panel's typed confirmation remains a separate human path for
`requestPublish` / `requestRollback`. The preview share smoke does not use
that immediate path.

## 2026.1 Preview smoke

The self-hosted fixture (`mock-server.mjs`, `test/lifecycle/share-preview-smoke.test.ts`)
qualifies the governed preview:

1. `honua_studio_propose_publication` accepts `itemId`, `versionId`,
   `contentHash`, `route`, and `visibility` for the current saved version
   and returns `AwaitingApproval`, `humanConfirmationRequired`, and a
   `honua://proposals/{proposalId}` handle. It does not return a URL.
2. The handle is retained and read back from a new storage view, which is
   the reload boundary. The shell restores that handle into the chat.
3. Pending, rejected, and failed states are projected into the conversation.
   Rejected and failed issue no link, and they do not move the published
   pointer.
4. The proposer's own token cannot approve. Another owner's read is forbidden.
   A different principal's approval is what moves the published pointer.
5. Only an `Active` status payload can supply the link, and only when that
   payload's URL is absolute `http` or `https` and is not the proposal URI.
   The conversation copies that URL; it does not invent one.
6. The same fence applies to `private` and `public`.

The fixture's version ids are the mock's own ids, not a claim that a GA
server accepted a UUID proposal. A real-model turn is not part of this
smoke: the pinned `@honua/sdk-js` `StudioAgentSession` still stamps
`draftId` and `generation` onto composition calls, which the canonical
proposal schema rejects.

## 2026.2 graduation checklist

Before Studio sharing leaves Preview:

- owner/RBAC, audit/correlation, and separation-of-duties behavior matches
  the terminal and Console clients on a GA server;
- restart and cross-replica qualification proves the proposal and published
  version are durable;
- the live agent session submits the canonical proposal without draft fields;
- release receipts bind the Studio, SDK, and GA-server revisions exercised
  by the full browser journey.
