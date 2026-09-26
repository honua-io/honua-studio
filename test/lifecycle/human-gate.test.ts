/**
 * THE HUMAN GATE — spec REQ-009 (honua-studio#9 build item 3).
 *
 * "Publish, share, embed, and any action that widens exposure are
 * HUMAN-CONFIRMED gates the agent can propose but never invoke."
 *
 * Two independent proofs, because neither alone is sufficient:
 *
 *  1. STATIC: no source file under `src/mcp/**`, `src/chat/**`, or
 *     `src/composition/**` — the entire chat/tool-call/composition-engine
 *     surface an agent's actions flow through — contains a call to
 *     `.requestPublish(` or `.requestRollback(` (the two
 *     `StudioLifecycleClient` methods that widen exposure), and none of
 *     them import `lifecycle-client.js` at all. `studio-lifecycle-panel-element.ts`
 *     is the sole file anywhere in `src/` that calls either method — this
 *     is checked by asserting the set of matching files is exactly
 *     `{ lifecycle-client.ts (the declaration), studio-lifecycle-panel-element.ts (the one caller) }`.
 *
 *     A static check alone is gameable (an agent path could reach the
 *     panel's public methods through some other route this grep can't see,
 *     e.g. a chat-driven `document.querySelector(...).requestPublish...`
 *     escape hatch) — hence proof 2.
 *
 *  2. RUNTIME: drives `honua_studio_propose_publication` — the ONLY
 *     publish-adjacent MCP tool an agent can call — through the REAL MCP
 *     client + REAL mock-server `/mcp` dispatcher, and asserts, against the
 *     REAL REST lifecycle store, that the call records an `AwaitingApproval`
 *     proposal and does not move the published pointer.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { StudioLifecycleClient } from "../../src/lifecycle/lifecycle-client.js";
import { McpClient } from "../../src/mcp/client.js";
import { StudioMcpToolClient } from "../../src/mcp/studio-tools.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const srcRoot = join(repoRoot, "src");

/** Every `.ts` file under `src/`, relative to `src/`. */
function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (entry.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

const GATED_METHOD_CALL_PATTERN = /\.(requestPublish|requestRollback)\(/;
const LIFECYCLE_CLIENT_IMPORT_PATTERN = /from\s+["'][^"']*lifecycle-client\.js["']/;

describe("THE HUMAN GATE — spec REQ-009 (static analysis)", () => {
  const allSourceFiles = listSourceFiles(srcRoot);

  it("the only file anywhere under src/ that calls .requestPublish(/.requestRollback( is the lifecycle panel element", () => {
    const callers = allSourceFiles
      .filter((file) => GATED_METHOD_CALL_PATTERN.test(readFileSync(file, "utf8")))
      .map((file) => relative(srcRoot, file));
    expect(callers).toEqual(["elements/studio-lifecycle-panel-element.ts"]);
  });

  it("no file under src/mcp/**, src/chat/**, or src/composition/** imports lifecycle-client.js at all", () => {
    const agentReachableDirs = ["mcp", "chat", "composition"];
    const offenders: string[] = [];
    for (const file of allSourceFiles) {
      const relativePath = relative(srcRoot, file);
      if (!agentReachableDirs.some((dir) => relativePath.startsWith(`${dir}/`))) continue;
      const content = readFileSync(file, "utf8");
      if (LIFECYCLE_CLIENT_IMPORT_PATTERN.test(content) || GATED_METHOD_CALL_PATTERN.test(content)) {
        offenders.push(relativePath);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("honua_studio_propose_publication's typed argument/output shapes (mcp/studio-tools.ts) never reference a publish/rollback pointer field", () => {
    const content = readFileSync(join(srcRoot, "mcp/studio-tools.ts"), "utf8");
    const proposeSection = content.slice(
      content.indexOf("interface ProposeStudioPublicationInput"),
      content.indexOf("STUDIO_MCP_TOOL_NAMES"),
    );
    expect(proposeSection).not.toMatch(/publishedVersionId|currentVersionId|pointer\s*:/);
  });
});

let server: Awaited<ReturnType<typeof startMockServer>> | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("THE HUMAN GATE — spec REQ-009 (runtime proof against the real mock server)", () => {
  it("honua_studio_propose_publication (the agent's ONLY publish-adjacent tool) never moves the published pointer", async () => {
    server = await startMockServer();
    const token = mintFixtureAccessToken();

    // The exact agent-reachable path: McpClient + StudioMcpToolClient over
    // the real /mcp JSON-RPC dispatcher — the same client
    // ToolCallOrchestrator (src/mcp/orchestrator.ts) uses in live mode.
    // McpClient POSTs to `${baseUrl}/mcp`, matching mock-server's unprefixed
    // /mcp route directly (no /api rewrite in this test, same as
    // test/mcp/mock-mcp-server.test.ts's convention).
    const mcpClient = new McpClient({ baseUrl: server.url, auth: { getAccessToken: async () => token } });
    const tools = new StudioMcpToolClient(mcpClient);

    const lifecycle = new StudioLifecycleClient({ baseUrl: server.url, auth: { getAccessToken: async () => token } });
    const draft = await tools.createDraft({ packageKey: "human-gate-pkg", family: "map", schemaVersion: "1.0" });
    const version = await lifecycle.saveAsVersion(draft.draftId, "ready");

    const proposal = await tools.proposePublication({
      itemId: version.itemId,
      versionId: version.versionId,
      contentHash: version.contentHash,
      route: "/studio/human-gate-pkg",
      visibility: "organization",
      note: "Ready for review.",
    });
    expect(proposal.status).toBe("AwaitingApproval");
    expect(proposal.humanConfirmationRequired).toBe(true);
    expect(proposal.proposalUri).toBe(`honua://proposals/${proposal.proposalId}`);
    expect(proposal).not.toHaveProperty("publicationUrl");

    const items = await lifecycle.listContentItems({ q: "human-gate-pkg" });
    expect(items.items).toHaveLength(1);
    expect(items.items[0]?.state).toBe("current");
    expect(items.items[0]?.publishedVersionId).toBeUndefined();
    expect(items.items[0]?.publication).toBeUndefined();
  });

  it("repeating a proposal still does not move the published pointer", async () => {
    server = await startMockServer();
    const token = mintFixtureAccessToken();
    const mcpClient = new McpClient({ baseUrl: server.url, auth: { getAccessToken: async () => token } });
    const tools = new StudioMcpToolClient(mcpClient);
    const lifecycle = new StudioLifecycleClient({ baseUrl: server.url, auth: { getAccessToken: async () => token } });

    const draft = await tools.createDraft({ packageKey: "human-gate-repeat", family: "map", schemaVersion: "1.0" });
    const version = await lifecycle.saveAsVersion(draft.draftId);
    const input = {
      itemId: version.itemId,
      versionId: version.versionId,
      contentHash: version.contentHash,
      route: "/a",
      visibility: "private",
    };
    const first = await tools.proposePublication(input);
    const second = await tools.proposePublication({ ...input, visibility: "public" });
    expect(first.proposalId).not.toBe(second.proposalId);
    expect(first.status).toBe("AwaitingApproval");
    expect(second.status).toBe("AwaitingApproval");

    const items = await lifecycle.listContentItems({ q: "human-gate-repeat" });
    expect(items.items[0]?.state).toBe("current");
    expect(items.items[0]?.publishedVersionId).toBeUndefined();
  });
});
