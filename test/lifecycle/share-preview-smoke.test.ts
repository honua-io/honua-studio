/**
 * Governed preview share smoke (honua-studio#26). The fixture server is the
 * self-hosted preview, not a GA server. Private and public both wait for a
 * different principal, and the conversation copies a URL only from an Active
 * status read.
 */
import { afterEach, describe, expect, it } from "vitest";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import {
  type ShareProposalHandle,
  type ShareProposalStorage,
  fetchShareProposalStatus,
  loadShareProposal,
  projectShareConversation,
  retainShareProposal,
  shareHandleFromSubmission,
  verifiedPublicationUrl,
} from "../../src/chat/share-preview.js";
import { StudioLifecycleClient } from "../../src/lifecycle/lifecycle-client.js";
import { McpClient } from "../../src/mcp/client.js";
import { StudioMcpToolClient } from "../../src/mcp/studio-tools.js";

let server: Awaited<ReturnType<typeof startMockServer>> | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function memoryStorage(seed?: string): ShareProposalStorage & { raw(): string | null } {
  let value = seed ?? null;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
    raw: () => value,
  };
}

async function decide(url: string, token: string, proposalId: string, decision: "approve" | "reject" | "fail") {
  const response = await fetch(`${url}/v1/studio/publication-proposals/${encodeURIComponent(proposalId)}/decision`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  const body = await response.json();
  return { status: response.status, body };
}

describe("governed preview share smoke", () => {
  it("keeps a private proposal pending across reload and returns the server link only after a different principal approves", async () => {
    server = await startMockServer();
    const proposer = mintFixtureAccessToken();
    const approver = mintFixtureAccessToken({ sub: "studio-approver", name: "Approver" });
    const stranger = mintFixtureAccessToken({ sub: "studio-stranger", name: "Stranger" });
    const tools = new StudioMcpToolClient(
      new McpClient({ baseUrl: server.url, auth: { getAccessToken: async () => proposer } }),
    );
    const lifecycle = new StudioLifecycleClient({
      baseUrl: server.url,
      auth: { getAccessToken: async () => proposer },
    });
    const draft = await tools.createDraft({ packageKey: "share-private", family: "map", schemaVersion: "1.0" });
    const version = await lifecycle.saveAsVersion(draft.draftId, "share");
    const submitted = {
      itemId: version.itemId,
      versionId: version.versionId,
      contentHash: version.contentHash,
      route: "/maps/share-private",
      visibility: "private",
    };
    const proposal = await tools.proposePublication(submitted);
    const replay = await tools.proposePublication(submitted);
    expect(replay.proposalId).toBe(proposal.proposalId);
    expect(proposal).not.toHaveProperty("publicationUrl");

    const handle = shareHandleFromSubmission({ ...submitted, ...proposal });
    expect(handle).toBeDefined();
    const stored = memoryStorage();
    retainShareProposal(stored, handle as ShareProposalHandle);
    const reloaded = loadShareProposal(memoryStorage(stored.raw() ?? undefined));
    expect(reloaded).toEqual(handle);

    const pending = projectShareConversation(reloaded as ShareProposalHandle, {
      proposalId: proposal.proposalId,
      status: "AwaitingApproval",
    });
    expect(pending.text).toContain("pending separate human approval");
    expect(pending.text).toContain(proposal.proposalUri);
    expect(pending.publicationUrl).toBeUndefined();

    const before = await lifecycle.listContentItems({ q: "share-private" });
    expect(before.items[0]?.publishedVersionId).toBeUndefined();
    expect((await decide(server.url, proposer, proposal.proposalId, "approve")).status).toBe(403);
    expect((await lifecycle.listContentItems({ q: "share-private" })).items[0]?.publishedVersionId).toBeUndefined();

    const hidden = await fetch(`${server.url}/v1/studio/publication-proposals/${proposal.proposalId}`, {
      headers: { authorization: `Bearer ${stranger}` },
    });
    expect(hidden.status).toBe(403);

    const approved = await decide(server.url, approver, proposal.proposalId, "approve");
    expect(approved.status).toBe(200);
    const status = await fetchShareProposalStatus(server.url, proposal.proposalId, proposer);
    expect(status?.status).toBe("Active");
    expect(status?.publicationUrl).toBe(approved.body.data.publicationUrl);
    const shared = projectShareConversation(reloaded as ShareProposalHandle, status ?? { proposalId: "", status: "" });
    expect(shared.publicationUrl).toBe(status?.publicationUrl);
    expect(shared.text).toBe(`Shared — ${status?.publicationUrl}`);
    expect((await lifecycle.listContentItems({ q: "share-private" })).items[0]?.publishedVersionId).toBe(
      version.versionId,
    );
  });

  it("keeps public, rejected, and failed proposals unpublished and link-free", async () => {
    server = await startMockServer();
    const proposer = mintFixtureAccessToken();
    const approver = mintFixtureAccessToken({ sub: "studio-approver", name: "Approver" });
    const tools = new StudioMcpToolClient(
      new McpClient({ baseUrl: server.url, auth: { getAccessToken: async () => proposer } }),
    );
    const lifecycle = new StudioLifecycleClient({
      baseUrl: server.url,
      auth: { getAccessToken: async () => proposer },
    });

    async function propose(packageKey: string, visibility: string) {
      const draft = await tools.createDraft({ packageKey, family: "map", schemaVersion: "1.0" });
      const version = await lifecycle.saveAsVersion(draft.draftId);
      const proposal = await tools.proposePublication({
        itemId: version.itemId,
        versionId: version.versionId,
        contentHash: version.contentHash,
        route: `/maps/${packageKey}`,
        visibility,
      });
      return { version, proposal };
    }

    const publicProposal = await propose("share-public", "public");
    expect(publicProposal.proposal.status).toBe("AwaitingApproval");
    expect((await lifecycle.listContentItems({ q: "share-public" })).items[0]?.publishedVersionId).toBeUndefined();

    const rejected = await propose("share-rejected", "private");
    expect((await decide(server.url, approver, rejected.proposal.proposalId, "reject")).status).toBe(200);
    const rejectedStatus = await fetchShareProposalStatus(server.url, rejected.proposal.proposalId, proposer);
    const rejectedHandle = shareHandleFromSubmission({
      itemId: rejected.version.itemId,
      versionId: rejected.version.versionId,
      contentHash: rejected.version.contentHash,
      route: "/maps/share-rejected",
      visibility: "private",
      ...rejected.proposal,
    });
    const rejectedNote = projectShareConversation(rejectedHandle as ShareProposalHandle, rejectedStatus as never);
    expect(rejectedNote.text).toContain("rejected");
    expect(rejectedNote.publicationUrl).toBeUndefined();
    expect((await lifecycle.listContentItems({ q: "share-rejected" })).items[0]?.publishedVersionId).toBeUndefined();

    const failed = await propose("share-failed", "public");
    expect((await decide(server.url, approver, failed.proposal.proposalId, "fail")).status).toBe(200);
    const failedStatus = await fetchShareProposalStatus(server.url, failed.proposal.proposalId, proposer);
    const failedHandle = shareHandleFromSubmission({
      itemId: failed.version.itemId,
      versionId: failed.version.versionId,
      contentHash: failed.version.contentHash,
      route: "/maps/share-failed",
      visibility: "public",
      ...failed.proposal,
    });
    const failedNote = projectShareConversation(failedHandle as ShareProposalHandle, failedStatus as never);
    expect(failedNote.text).toContain("failed");
    expect(failedNote.publicationUrl).toBeUndefined();
    expect(failedStatus?.publicationUrl).toBeUndefined();
    expect((await lifecycle.listContentItems({ q: "share-failed" })).items[0]?.publishedVersionId).toBeUndefined();
  });

  it("refuses an approval smuggle and a mismatched content hash without publishing", async () => {
    server = await startMockServer();
    const token = mintFixtureAccessToken();
    const tools = new StudioMcpToolClient(
      new McpClient({ baseUrl: server.url, auth: { getAccessToken: async () => token } }),
    );
    const lifecycle = new StudioLifecycleClient({ baseUrl: server.url, auth: { getAccessToken: async () => token } });
    const draft = await tools.createDraft({ packageKey: "share-refused", family: "map", schemaVersion: "1.0" });
    const version = await lifecycle.saveAsVersion(draft.draftId);
    await expect(
      tools.proposePublication({
        itemId: version.itemId,
        versionId: version.versionId,
        contentHash: version.contentHash,
        route: "/maps/share-refused",
        visibility: "private",
        approve: true,
      } as never),
    ).rejects.toThrow(/approve/i);
    await expect(
      tools.proposePublication({
        itemId: version.itemId,
        versionId: version.versionId,
        contentHash: "not-the-saved-hash",
        route: "/maps/share-refused",
        visibility: "public",
      }),
    ).rejects.toThrow(/content hash/i);
    expect((await lifecycle.listContentItems({ q: "share-refused" })).items[0]?.publishedVersionId).toBeUndefined();
  });

  it("does not treat a non-active or unverified URL as a share link", () => {
    const handle = {
      proposalId: "proposal-1",
      proposalUri: "honua://proposals/proposal-1",
      itemId: "item",
      versionId: "version",
      contentHash: "hash",
      route: "/maps/x",
      visibility: "public",
      operationInstanceId: "op",
      auditId: "audit",
      correlationId: "corr",
      idempotencyIdentity: "key",
    } satisfies ShareProposalHandle;
    expect(
      projectShareConversation(handle, {
        proposalId: handle.proposalId,
        status: "Approved",
        publicationUrl: "https://evil.example/x",
      }).publicationUrl,
    ).toBeUndefined();
    expect(projectShareConversation(handle, { proposalId: handle.proposalId, status: "Executing" }).text).toContain(
      "No link",
    );
    expect(
      projectShareConversation(handle, {
        proposalId: handle.proposalId,
        status: "Active",
        publicationUrl: handle.proposalUri,
      }).publicationUrl,
    ).toBeUndefined();
    expect(verifiedPublicationUrl("javascript:alert(1)", handle.proposalUri)).toBeUndefined();
    expect(
      projectShareConversation(handle, {
        proposalId: "other",
        status: "Active",
        publicationUrl: "https://studio.preview.invalid/share/proposal-1",
      }).publicationUrl,
    ).toBeUndefined();
  });
});
