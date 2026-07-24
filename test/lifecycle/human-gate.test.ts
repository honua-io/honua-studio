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
 *     client + REAL mock-server `/mcp` dispatcher (the exact path a chat
 *     tool-call intent takes via `ToolCallOrchestrator`), and asserts,
 *     against the REAL REST lifecycle store (the SAME store per this
 *     issue's "one store, both surfaces" design), that the content item's
 *     published pointer never moves and no publication/rollback request was
 *     ever recorded — proving the agent path has NO side effect beyond the
 *     documented "intent recorded on the draft", regardless of what code
 *     exists elsewhere in the app.
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
    // Structural corroboration: the propose-publication input/output types
    // carry only intent fields (route/visibility/embed/service/schedule/job/note)
    // and draft/recorded/humanConfirmationRequired/message — never
    // `publishedVersionId`, `currentVersionId`, or a `pointer` field, which
    // would be the tell of an accidental publish/rollback side channel.
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
  it("honua_studio_propose_publication (the agent's ONLY publish-adjacent tool) never moves the published pointer or records a publication/rollback request", async () => {
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

    const draft = await tools.createDraft({ packageKey: "human-gate-pkg", family: "map", schemaVersion: "1.0" });

    const proposal = await tools.proposePublication({
      draftId: draft.draftId,
      generation: draft.generation,
      route: "/studio/human-gate-pkg",
      visibility: "organization",
      note: "Ready for review.",
    });
    expect(proposal.recorded).toBe(true);
    expect(proposal.humanConfirmationRequired).toBe(true);
    expect(proposal.draft.generation).toBeGreaterThan(draft.generation); // recording intent advances generation, same as any other update

    // The REST lifecycle client (a completely independent transport/surface
    // from the /mcp path above) reads the SAME shared store (this issue's
    // "one store, both surfaces" design) — proving the propose-publication
    // call had NO effect beyond writing publicationIntent onto the draft.
    const lifecycle = new StudioLifecycleClient({ baseUrl: server.url, auth: { getAccessToken: async () => token } });
    const restDraft = await lifecycle.getDraft(draft.draftId);
    expect(restDraft.envelope.publicationIntent).toEqual({
      route: "/studio/human-gate-pkg",
      visibility: "organization",
      note: "Ready for review.",
    });

    const items = await lifecycle.listContentItems({ q: "human-gate-pkg" });
    expect(items.items).toHaveLength(1);
    expect(items.items[0]?.state).toBe("draft"); // never advanced to "current" or "published"
    expect(items.items[0]?.currentVersionId).toBeUndefined();
    expect(items.items[0]?.publishedVersionId).toBeUndefined();
    expect(items.items[0]?.publication).toBeUndefined(); // no publication badge — nothing was ever published
  });

  it("proposing publication twice, then never confirming, still leaves zero publication/rollback requests recorded anywhere in the store", async () => {
    server = await startMockServer();
    const token = mintFixtureAccessToken();
    const mcpClient = new McpClient({ baseUrl: server.url, auth: { getAccessToken: async () => token } });
    const tools = new StudioMcpToolClient(mcpClient);

    const draft = await tools.createDraft({ packageKey: "human-gate-repeat", family: "map", schemaVersion: "1.0" });
    await tools.proposePublication({ draftId: draft.draftId, generation: draft.generation, route: "/a" });
    const refreshed = await tools.getDraft(draft.draftId);
    await tools.proposePublication({ draftId: refreshed.draftId, generation: refreshed.generation, route: "/b" });

    // No REST publish-request/rollback-request endpoint was ever hit by any
    // of the above — verified indirectly: the item was never saved as a
    // version at all (propose-publication only touches the draft), so there
    // is nothing a publish-request could even target yet.
    const lifecycle = new StudioLifecycleClient({ baseUrl: server.url, auth: { getAccessToken: async () => token } });
    const versions = await lifecycle.listVersions(draft.itemId ?? draft.draftId);
    expect(versions.versions).toEqual([]);
    const items = await lifecycle.listContentItems({ q: "human-gate-repeat" });
    expect(items.items[0]?.state).toBe("draft");
  });
});
