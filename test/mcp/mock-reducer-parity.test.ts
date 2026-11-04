/**
 * The mock server's `honua_studio_*` composition tools and the client reducer must reach the same
 * composition for the same command: each case seeds one draft body, applies a command through
 * `applyCompositionCommand` and, as the live orchestrator would send it, through the mock's `/mcp` tool.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import type { CompositionCommand } from "../../src/composition/commands.js";
import { CompositionCommandError, applyCompositionCommand } from "../../src/composition/reducer.js";
import { readCompositionBody } from "../../src/lifecycle/composition-draft-store.js";
import { McpClient } from "../../src/mcp/client.js";
import { McpToolError } from "../../src/mcp/errors.js";
import { type StudioMcpDraft, StudioMcpToolClient, parseStudioDraftResult } from "../../src/mcp/studio-tools.js";
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
  readonly tool: { readonly name: string; readonly arguments: Record<string, unknown> };
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

async function openMockDraft(body: string) {
  server = await startMockServer();
  const token = mintFixtureAccessToken();
  const client = new McpClient({ baseUrl: server.url, auth: { getAccessToken: async () => token } });
  return { client, draft: await seededDraft(client, FIXTURE.bodies[body]) };
}

/** The fixture's own tool call, for honua-server to replay, must be the call the bridge sends. */
function fixtureInvocation({ command, tool }: ParityCase, draft: StudioMcpDraft) {
  const invocation = {
    name: tool.name,
    arguments: { ...tool.arguments, draftId: draft.draftId, generation: draft.generation },
  };
  const resolution = resolveToolCall({ toolName: command.name, arguments: { ...command } });
  if (!resolution.ok || !resolution.serverToolName) throw new Error(`No server tool for ${command.name}.`);
  expect(invocation).toEqual(buildServerToolInvocation(resolution, draft));
  return invocation;
}

async function applyThroughMock(parityCase: ParityCase): Promise<unknown> {
  const { client, draft } = await openMockDraft(parityCase.body);
  const invocation = fixtureInvocation(parityCase, draft);
  const result = parseStudioDraftResult(await client.callTool(invocation.name, invocation.arguments));
  return readComparableBody(result.envelope.body);
}

async function refuseThroughMock(parityCase: ParityCase): Promise<{ error: McpToolError; unchanged: boolean }> {
  const { client, draft } = await openMockDraft(parityCase.body);
  const invocation = fixtureInvocation(parityCase, draft);
  const error = await client.callTool(invocation.name, invocation.arguments).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof McpToolError)) throw new Error(`Expected a tool error, got ${String(error)}.`);
  const after = await new StudioMcpToolClient(client).getDraft(draft.draftId);
  const unchanged =
    after.generation === draft.generation &&
    JSON.stringify(readComparableBody(after.envelope.body)) === JSON.stringify(readComparableBody(draft.envelope.body));
  return { error, unchanged };
}

function applyThroughReducer({ body, command }: ParityCase): unknown {
  const { state } = applyCompositionCommand(readCompositionBody(FIXTURE.bodies[body]), command);
  return readComparableBody(toStudioCompositionBody(state));
}

function expectMessage(actual: string, expected: ExpectedError): void {
  if (expected.message !== undefined) expect(actual).toBe(expected.message);
  else expect(actual).toContain(expected.messageIncludes);
}

function captureReducerError(parityCase: ParityCase): CompositionCommandError {
  try {
    applyThroughReducer(parityCase);
  } catch (error) {
    if (error instanceof CompositionCommandError) return error;
    throw error;
  }
  throw new Error(`The reducer accepted "${parityCase.name}".`);
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
    const expected = parityCase.expect.error!;
    const reducerError = captureReducerError(parityCase);
    expect(reducerError.code).toBe(expected.reducerCode);
    expectMessage(reducerError.message, expected);

    const { error, unchanged } = await refuseThroughMock(parityCase);
    expect(error.code).toBe(expected.mcpCode);
    expect(error.data).toEqual({ code: expected.mcpCode, message: error.message });
    expectMessage(error.message, expected);
    expect(unchanged).toBe(true);
  });
});
