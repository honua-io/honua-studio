# Share and publication approval

Studio treats every action that widens exposure as governed, including public,
organization-only, unlisted, embed, and private-link publication.

1. The agent may call only `honua_studio_propose_publication`. This records
   intent on a draft and produces a visible pending proposal.
2. A person reviews the target/visibility and types the package key in the
   lifecycle confirmation surface. No agent-executable tool can submit that
   confirmation.
3. Studio polls the publication request status contract from
   honua-server#3304. Pending and rejected states remain visible.
4. Only an `approved` or `published` status carrying `publicUrl` produces a
   clickable link and returns that link into the conversation.

The mock server implements a deterministic, synchronous status fixture for
contract tests. A real-server approval/link receipt remains blocked on #3304.
