/**
 * THE HUMAN GATE — spec REQ-009 discipline extended to GP execution
 * (honua-studio#10 build item 3, mirroring `test/lifecycle/human-gate.test.ts`
 * EXACTLY).
 *
 * "EXECUTION of a GP job is a human action after a confirmed preview plan —
 * the agent can author and validate the package and propose execution, but
 * the run button is the human's."
 *
 * Two independent proofs, because neither alone is sufficient:
 *
 *  1. STATIC: no source file under `src/mcp/**`, `src/chat/**`, or
 *     `src/composition/**` — the entire chat/tool-call/composition-engine
 *     surface an agent's actions flow through — contains a call to
 *     `.submit(` (the one `GpJobClient` method that starts batch
 *     execution), and none of them import `job-client.js` at all.
 *     `studio-gp-panel-element.ts` is the sole file anywhere in `src/` that
 *     CALLS `.submit(` — checked by asserting the set of matching files is
 *     exactly `{ studio-gp-panel-element.ts }` (`job-client.ts` itself only
 *     DECLARES the method — `public submit(` has no leading dot — so it
 *     never matches the call-site pattern; that asymmetry is the point).
 *
 *     A static check alone is gameable (an agent path could reach the
 *     panel's public methods through some other route this grep can't see)
 *     — hence proof 2.
 *
 *  2. RUNTIME: drives `GpAuthoringSession` (the agent's ENTIRE reach into GP
 *     — create draft, add input/parameter/output, validate, preview-plan)
 *     through the REAL MCP client + REAL mock-server `/mcp` dispatcher (the
 *     exact path a chat tool-call intent takes), and asserts, against the
 *     REAL `mock-server.mjs` GP job store, that NO job was ever created —
 *     proving the agent path has no side effect that could ever start
 *     billed batch compute, regardless of what code exists elsewhere in the
 *     app.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { runGpFixtureAuthoring } from "../../src/gp/fixtures/index.js";
import { GpAuthoringSession } from "../../src/gp/gp-authoring-session.js";
import { McpClient } from "../../src/mcp/client.js";
import { StudioMcpToolClient } from "../../src/mcp/studio-tools.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const srcRoot = join(repoRoot, "src");

function relativeSource(file: string): string {
  return relative(srcRoot, file).replaceAll("\\", "/");
}

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

const GATED_METHOD_CALL_PATTERN = /\.submit\(/;
const JOB_CLIENT_IMPORT_PATTERN = /from\s+["'][^"']*job-client\.js["']/;

describe("THE HUMAN GATE (GP execution) — spec REQ-009 discipline (static analysis)", () => {
  const allSourceFiles = listSourceFiles(srcRoot);

  it("the only file anywhere under src/ that calls .submit( is the gp panel element", () => {
    const callers = allSourceFiles
      .filter((file) => GATED_METHOD_CALL_PATTERN.test(readFileSync(file, "utf8")))
      .map(relativeSource)
      .sort();
    expect(callers).toEqual(["elements/studio-gp-panel-element.ts"]);
  });

  it("no file under src/mcp/**, src/chat/**, or src/composition/** imports job-client.js at all, or calls .submit(", () => {
    const agentReachableDirs = ["mcp", "chat", "composition"];
    const offenders: string[] = [];
    for (const file of allSourceFiles) {
      const relativePath = relativeSource(file);
      if (!agentReachableDirs.some((dir) => relativePath.startsWith(`${dir}/`))) continue;
      const content = readFileSync(file, "utf8");
      if (JOB_CLIENT_IMPORT_PATTERN.test(content) || GATED_METHOD_CALL_PATTERN.test(content)) {
        offenders.push(relativePath);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("GpAuthoringSession (src/gp/gp-authoring-session.ts, the agent's entire reach into GP) never imports job-client.js", () => {
    const content = readFileSync(join(srcRoot, "gp/gp-authoring-session.ts"), "utf8");
    expect(JOB_CLIENT_IMPORT_PATTERN.test(content)).toBe(false);
    expect(GATED_METHOD_CALL_PATTERN.test(content)).toBe(false);
  });
});

let server: Awaited<ReturnType<typeof startMockServer>> | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("THE HUMAN GATE (GP execution) — spec REQ-009 discipline (runtime proof against the real mock server)", () => {
  it("the agent's full authoring path (author -> validate -> preview) never creates a GP job", async () => {
    server = await startMockServer();
    const token = mintFixtureAccessToken();

    // The exact agent-reachable path: McpClient + StudioMcpToolClient +
    // GpAuthoringSession over the real /mcp JSON-RPC dispatcher — the same
    // client `ToolCallOrchestrator` uses in live mode, applied to GP
    // authoring instead of composition mutation.
    const mcpClient = new McpClient({ baseUrl: server.url, auth: { getAccessToken: async () => token } });
    const tools = new StudioMcpToolClient(mcpClient);
    const session = new GpAuthoringSession({ tools, packageKey: "human-gate-gp-pkg" });

    const result = await runGpFixtureAuthoring(session);
    expect(result.draft.envelope.family).toBe("gp");
    expect(result.validation).toBeDefined();
    expect(result.preview).toBeDefined();

    // No REST /gp-jobs endpoint was ever hit by any of the above — verified
    // directly against the real store: GET /v1/studio/gp-jobs/{anything}
    // 404s because the map is empty, not because of a wrong id, and a
    // fresh submit attempt from THIS test (never from the agent path above)
    // is the only way a job could exist.
    const draftsResponse = await fetch(`${server.url}/v1/studio/package-drafts?q=human-gate-gp-pkg`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const drafts = await draftsResponse.json();
    expect(drafts.data.items).toHaveLength(1);

    // The runtime discriminant that actually matters: ask the job surface
    // about a job id that would only exist if `submit` had ever been
    // called anywhere in the agent path above. It never was.
    const jobResponse = await fetch(`${server.url}/v1/studio/gp-jobs/mock-gp-job-1`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(jobResponse.status).toBe(404);
  });

  it("authoring the same package twice, then never submitting, still leaves the gp-jobs store untouched", async () => {
    server = await startMockServer();
    const token = mintFixtureAccessToken();
    const mcpClient = new McpClient({ baseUrl: server.url, auth: { getAccessToken: async () => token } });
    const tools = new StudioMcpToolClient(mcpClient);

    const sessionA = new GpAuthoringSession({ tools, packageKey: "human-gate-gp-repeat-a" });
    await runGpFixtureAuthoring(sessionA);
    const sessionB = new GpAuthoringSession({ tools, packageKey: "human-gate-gp-repeat-b" });
    await runGpFixtureAuthoring(sessionB);

    const jobResponse = await fetch(`${server.url}/v1/studio/gp-jobs/mock-gp-job-1`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(jobResponse.status).toBe(404);
  });
});
