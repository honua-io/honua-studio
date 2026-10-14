import {
  InMemoryStudioAiReplayStore,
  type StudioAiTranscriptSigningManifest,
  StudioAiTranscriptVerifier,
} from "@honua/sdk-js/studio-agent";
import { canonicalCompositionJson, createEmptyCompositionState } from "../composition/model.js";
import { applyCompositionCommands } from "../composition/reducer.js";
import { McpClient } from "../mcp/client.js";
import { StudioMcpToolClient } from "../mcp/studio-tools.js";
import { applyStudioDraft, toStudioCompositionBody } from "../mcp/tool-bridge.js";
import { EVAL_CORPUS } from "./corpus.js";
import { FixtureTurnDriver } from "./driver.js";
import { LiveTurnDriver } from "./live-driver.js";
import { runEvalTask } from "./runner.js";
import { scoreEvalRun } from "./scorer.js";

/** Scripted intents through the actual Studio MCP bridge; this does not evaluate a model. */
export async function runServerCorpus(options: {
  baseUrl: string;
  apiBaseUrl?: string;
  apiKey?: string;
  tokenProvider?: () => Promise<string>;
  runId: string;
  fetchImpl?: typeof fetch;
  sources?: readonly unknown[];
  model?: { provider: string; model: string; manifest: StudioAiTranscriptSigningManifest };
}) {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const apiBaseUrl = (options.apiBaseUrl ?? baseUrl).replace(/\/$/, "");
  const transport = options.fetchImpl ?? fetch;
  const cases: Array<Record<string, unknown> & { taskId: string; passed: boolean; cleanup: Record<string, unknown> }> =
    [];
  for (const originalTask of EVAL_CORPUS) {
    const transcript: unknown[] = [];
    // The fixture declares a local bridge event. In this lane that same operation must be server-backed.
    const task = {
      ...originalTask,
      expected: {
        ...originalTask.expected,
        activityLog: originalTask.expected.activityLog && {
          ...originalTask.expected.activityLog,
          present: originalTask.expected.activityLog.present?.map((entry) => ({
            ...entry,
            detail: entry.detail?.mode === "local" ? { ...entry.detail, mode: "server" } : entry.detail,
          })),
        },
      },
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      if (options.apiKey) headers.set("X-API-Key", options.apiKey);
      if (options.tokenProvider) headers.set("Authorization", `Bearer ${await options.tokenProvider()}`);
      const response = await transport(input, {
        ...init,
        headers,
        signal: init?.signal ?? AbortSignal.timeout(30_000),
      });
      transcript.push({
        url: String(input),
        method: init?.method ?? "GET",
        request: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        status: response.status,
        response: await response.clone().text(),
      });
      return response;
    };
    const client = new McpClient({ baseUrl, fetchImpl });
    const tools = new StudioMcpToolClient(client);
    const packageKey = `studio-corpus-${options.runId}-${task.id}`;
    let draftId: string | undefined;
    let observation: Record<string, unknown> = { taskId: task.id, title: task.title, passed: false };
    let cleanup: Record<string, unknown> = { passed: false, reason: "draft creation not confirmed" };
    try {
      const initial = applyCompositionCommands(createEmptyCompositionState(), task.setup ?? []).state;
      const created = await tools.createDraft({
        packageKey,
        family: "map",
        schemaVersion: "1.0",
        body: toStudioCompositionBody(initial),
      });
      draftId = created.draftId;
      const seeded = await tools.getDraft(draftId);
      if (
        canonicalCompositionJson(toStudioCompositionBody(applyStudioDraft(seeded))) !==
        canonicalCompositionJson(toStudioCompositionBody(initial))
      ) {
        throw new Error("Independent draft readback does not preserve the scenario setup.");
      }
      const driver = options.model
        ? new LiveTurnDriver({
            baseUrl: apiBaseUrl,
            mcpBaseUrl: baseUrl,
            sourceCatalog: options.sources,
            fetchImpl,
            provider: options.model.provider,
            model: options.model.model,
            draft: { draftId, generation: seeded.generation },
            certification: {
              candidateId: "studio-corpus-diagnostic",
              releaseId: "diagnostic",
              endpointIdentity: baseUrl,
              actionId: task.id,
              runNonce: `${options.runId}-${task.id}`,
            },
            transcriptVerifier: new StudioAiTranscriptVerifier({
              manifest: options.model.manifest,
              replayStore: new InMemoryStudioAiReplayStore(),
            }),
          })
        : new FixtureTurnDriver();
      const run = await runEvalTask(task, {
        driver,
        live: { client, packageKey, draftId, generation: seeded.generation },
      });
      const stored = await tools.getDraft(draftId);
      const localScore = scoreEvalRun(run);
      // No previous composition is supplied: absent server controls/interactions cannot inherit local success.
      // Pins and annotations are explicitly app-only and are never claimed as durable server state.
      const remoteState = { ...applyStudioDraft(stored), pins: run.state.pins, annotations: run.state.annotations };
      const remoteScore = scoreEvalRun({ ...run, state: remoteState });
      const serverCalls = run.toolCalls.filter((call) => call.outcome.ok && call.outcome.mode === "server").length;
      const toolCoverage = run.toolCalls.length === 0 || serverCalls > 0;
      observation = {
        taskId: task.id,
        title: task.title,
        passed: localScore.passed && remoteScore.passed && toolCoverage,
        packageKey,
        draftId,
        seeded,
        stored,
        localScore,
        remoteScore,
        serverCalls,
        toolCoverage,
        run,
        modelEvents: driver instanceof LiveTurnDriver ? driver.events : undefined,
        modelMessages: driver instanceof LiveTurnDriver ? driver.session.messages : undefined,
      };
    } catch (error) {
      observation.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (draftId) {
        try {
          const path = `${apiBaseUrl}/v1/studio/package-drafts/${encodeURIComponent(draftId)}`;
          const deleted = await fetchImpl(path, { method: "DELETE" });
          const absent = await fetchImpl(path);
          cleanup = {
            passed: deleted.ok && absent.status === 404,
            deleteStatus: deleted.status,
            readbackStatus: absent.status,
          };
        } catch (error) {
          cleanup = { passed: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
    }
    cases.push({
      ...observation,
      taskId: task.id,
      passed: observation.passed === true && cleanup.passed === true,
      cleanup,
      transcript,
    });
  }
  return {
    schemaVersion: "honua.studio.server-corpus.v1",
    mode: options.model ? "live-model-real-mcp" : "scripted-real-mcp",
    modelQualityEvaluated: Boolean(options.model),
    model: options.model
      ? { provider: options.model.provider, model: options.model.model, manifest: options.model.manifest }
      : undefined,
    releaseQualification: false,
    runId: options.runId,
    baseUrl,
    observedAt: new Date().toISOString(),
    sources: options.sources,
    passed: cases.every((entry) => entry.passed),
    cases,
  };
}
