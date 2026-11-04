/**
 * The mock server's `honua_studio_*` composition tools and the client reducer must reach the same
 * composition for the same command: each case seeds one draft body, applies a command through
 * `applyCompositionCommand` and, as the live orchestrator would send it, through the mock's `/mcp` tool.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import type { CompositionCommand } from "../../src/composition/commands.js";
import { applyCompositionCommand } from "../../src/composition/reducer.js";
import { readCompositionBody } from "../../src/lifecycle/composition-draft-store.js";
import { McpClient } from "../../src/mcp/client.js";
import { StudioMcpToolClient, parseStudioDraftResult } from "../../src/mcp/studio-tools.js";
import { buildServerToolInvocation, resolveToolCall, toStudioCompositionBody } from "../../src/mcp/tool-bridge.js";

interface ExpectedError {
  readonly reducerCode: string;
  readonly mcpCode: string;
  readonly message?: string;
  readonly messageIncludes?: string;
}

interface ParityCase {
  readonly name: string;
  readonly body: string;
  readonly command: CompositionCommand;
  readonly expect: { readonly body?: unknown; readonly error?: ExpectedError };
}

const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/composition-reducer-cases.v1.json", import.meta.url), "utf8"),
) as { readonly bodies: Record<string, unknown>; readonly cases: readonly ParityCase[] };

const ACCEPTED = FIXTURE.cases.filter((parityCase) => parityCase.expect.body !== undefined);
const REFUSED = FIXTURE.cases.filter((parityCase) => parityCase.expect.error !== undefined);

let server: Awaited<ReturnType<typeof startMockServer>> | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function seededDraft(client: McpClient, body: unknown) {
  const tools = new StudioMcpToolClient(client);
  const draft = await tools.createDraft({ packageKey: "pkg-parity", family: "map", schemaVersion: "1" });
  return tools.updateDraft({
    draftId: draft.draftId,
    generation: draft.generation,
    packageKey: "pkg-parity",
    schemaVersion: "1",
    body,
  });
}

async function applyThroughMock({ body, command }: ParityCase): Promise<unknown> {
  server = await startMockServer();
  const token = mintFixtureAccessToken();
  const client = new McpClient({ baseUrl: server.url, auth: { getAccessToken: async () => token } });
  const draft = await seededDraft(client, FIXTURE.bodies[body]);
  const resolution = resolveToolCall({ toolName: command.name, arguments: { ...command } });
  if (!resolution.ok || !resolution.serverToolName) throw new Error(`No server tool for ${command.name}.`);
  const invocation = buildServerToolInvocation(resolution, draft)!;
  const result = parseStudioDraftResult(await client.callTool(invocation.name, invocation.arguments));
  return readComparableBody(result.envelope.body);
}

function applyThroughReducer({ body, command }: ParityCase): unknown {
  const { state } = applyCompositionCommand(readCompositionBody(FIXTURE.bodies[body]), command);
  return readComparableBody(toStudioCompositionBody(state));
}

function expectedMessage(error: ExpectedError): string | RegExp {
  return error.message ?? new RegExp(escapeRegExp(error.messageIncludes ?? ""));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readComparableBody(body: unknown) {
  const { sourceBindings, styleRefs, mapSpec, layers, view, widgets, controls } = toStudioCompositionBody(
    readCompositionBody(body),
  );
  return { sourceBindings, styleRefs, mapSpec, layers, view, widgets, controls };
}

describe("mock server composition tools match the client reducer", () => {
  it.each(ACCEPTED)("$name", async (parityCase) => {
    expect(applyThroughReducer(parityCase)).toEqual(parityCase.expect.body);
    expect(await applyThroughMock(parityCase)).toEqual(parityCase.expect.body);
  });

  it.each(REFUSED)("$name", async (parityCase) => {
    const error = parityCase.expect.error!;
    expect(() => applyThroughReducer(parityCase)).toThrow(
      expect.objectContaining({ code: error.reducerCode, message: expect.stringMatching(expectedMessage(error)) }),
    );
    await expect(applyThroughMock(parityCase)).rejects.toMatchObject({
      code: error.mcpCode,
      message: expect.stringMatching(expectedMessage(error)),
    });
  });
});
