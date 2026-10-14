import {
  InMemoryStudioAiReplayStore,
  type StudioAiTranscriptSigningManifest,
  StudioAiTranscriptVerifier,
} from "@honua/sdk-js/studio-agent";
import { canonicalCompositionJson, createEmptyCompositionState } from "../composition/model.js";
import { applyCompositionCommands } from "../composition/reducer.js";
import { McpClient } from "../mcp/client.js";
import { MAP_COMPOSITION_ENVELOPE, toCompositionDraftBody } from "../mcp/composition-envelope.js";
import { StudioMcpToolClient } from "../mcp/studio-tools.js";
import { applyStudioDraft, toStudioCompositionBody } from "../mcp/tool-bridge.js";
import { AuthoritativeStyleProvider } from "../styles/authoritative-style-provider.js";
import {
  type LiveStyleObservation,
  type LiveStyleRequirement,
  applyAuthoritativeStyleEvidence,
} from "./authoritative-style-evidence.js";
import { EVAL_CORPUS } from "./corpus.js";
import { FixtureTurnDriver } from "./driver.js";
import { LiveTurnDriver } from "./live-driver.js";
import {
  LIVE_EXACT_CONTRACT,
  createLiveExactTask,
  readLiveExactStyles,
  scoreLiveExactRun,
} from "./live-exact-contract.js";
import { verifyLiveExactSources } from "./live-exact-prerequisites.js";
import { type LiveSemanticScore, type LiveTurnObservation, scoreLiveSemanticRun } from "./live-semantic-scorer.js";
import { type EvalRunResult, runEvalTask } from "./runner.js";
import { scoreEvalRun } from "./scorer.js";
import type { EvalTask } from "./types.js";

/** Fixture scripts or predeclared exact live tasks through the actual Studio MCP bridge. */
export async function runServerCorpus(options: {
  baseUrl: string;
  apiBaseUrl?: string;
  apiKey?: string;
  tokenProvider?: () => Promise<string>;
  runId: string;
  styleRequirements?: Readonly<Record<string, LiveStyleRequirement>>;
  observeStyles?: (context: {
    taskId: string;
    turnIndex: number;
    state: ReturnType<typeof createEmptyCompositionState>;
  }) => Promise<readonly LiveStyleObservation[]>;
  fetchImpl?: typeof fetch;
  sources?: readonly unknown[];
  model?: { provider: string; model: string; manifest: StudioAiTranscriptSigningManifest };
}) {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const apiBaseUrl = (options.apiBaseUrl ?? baseUrl).replace(/\/$/, "");
  const transport = options.fetchImpl ?? fetch;
  const cases: Array<
    Record<string, unknown> & {
      taskId: string;
      passed: boolean;
      cleanup: Record<string, unknown>;
      liveSemanticScore?: LiveSemanticScore;
    }
  > = [];
  for (const originalTask of EVAL_CORPUS) {
    const transcript: CorpusExchange[] = [];
    const perTurnReadbacks: LiveTurnObservation[] = [];
    let semanticRun: EvalRunResult | undefined;
    let semanticInitial: ReturnType<typeof createEmptyCompositionState> | undefined;
    let modelTrafficStart: number | undefined;
    let modelTraffic: readonly CorpusExchange[] = [];
    // The fixture declares a local bridge event. In this lane that same operation must be server-backed.
    const fixtureTask: EvalTask = {
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
    let task = fixtureTask;
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
    const exactBindings = {
      districtStyleId: options.styleRequirements?.["compose-districts-map"]?.styleId ?? "",
      councilStyleId: options.styleRequirements?.["pin-protects-flood-risk"]?.styleId ?? "",
    };
    try {
      if (options.model) {
        task = createLiveExactTask(fixtureTask, exactBindings);
        observation.contractTask = task;
        observation.sourceAdmission = await verifyLiveExactSources(options.sources, baseUrl, fetchImpl);
      }
      observation.contractTask = task;
      const initial = applyCompositionCommands(createEmptyCompositionState(), task.setup ?? []).state;
      semanticInitial = initial;
      const created = await tools.createDraft({
        packageKey,
        family: "map",
        schemaVersion: MAP_COMPOSITION_ENVELOPE.schemaVersion,
        body: toCompositionDraftBody(initial, packageKey),
      });
      draftId = created.draftId;
      const seeded = await tools.getDraft(draftId);
      if (
        canonicalCompositionJson(toStudioCompositionBody(applyStudioDraft(seeded))) !==
        canonicalCompositionJson(toStudioCompositionBody(initial))
      ) {
        throw new Error("Independent draft readback does not preserve the scenario setup.");
      }
      const authoritativeStyles: unknown[] = [];
      if (options.model) {
        const provider = new AuthoritativeStyleProvider({
          baseUrl,
          documentUrl: baseUrl,
          getAuth: () => undefined,
          fetchImpl,
          signal: AbortSignal.timeout(8000),
        });
        const definitions = await readLiveExactStyles(task.id, exactBindings, (styleId) => provider.read(styleId));
        for (const definition of definitions) {
          authoritativeStyles.push({
            styleId: definition.styleId,
            title: definition.title,
            description: definition.description,
            styleVersion: definition.styleVersion,
            sha256: definition.sha256,
            serverRoot: definition.serverRoot,
          });
        }
      }
      observation.styleAdmission = authoritativeStyles;
      const driver = options.model
        ? new LiveTurnDriver({
            baseUrl: apiBaseUrl,
            mcpBaseUrl: baseUrl,
            sourceCatalog: options.sources,
            authoritativeStyles,
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
      modelTrafficStart = transcript.length;
      const run = await runEvalTask(task, {
        driver,
        live: { client, packageKey, draftId, generation: seeded.generation },
        observeTurn: async (turn, localState) => {
          try {
            const observed = await tools.getDraft(created.draftId);
            let styles: readonly LiveStyleObservation[] | undefined;
            let styleObservationError: string | undefined;
            try {
              styles = await options.observeStyles?.({
                taskId: task.id,
                turnIndex: turn.turnIndex,
                state: applyStudioDraft(observed),
              });
            } catch (error) {
              styleObservationError = error instanceof Error ? error.message : String(error);
            }
            perTurnReadbacks.push({
              styles,
              styleObservationError,
              turnIndex: turn.turnIndex,
              localState,
              serverState: applyStudioDraft(observed),
              generation: observed.generation,
            });
          } catch (error) {
            perTurnReadbacks.push({
              turnIndex: turn.turnIndex,
              localState,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      });
      semanticRun = run;
      modelTraffic = transcript.slice(modelTrafficStart);
      const stored = await tools.getDraft(draftId);
      const score = options.model ? scoreLiveExactRun : scoreEvalRun;
      const localScore = score(run);
      // No previous composition is supplied: absent server controls/interactions cannot inherit local success.
      // Pins and annotations are explicitly app-only and are never claimed as durable server state.
      const remoteState = { ...applyStudioDraft(stored), pins: run.state.pins, annotations: run.state.annotations };
      const remoteScore = score({ ...run, state: remoteState });
      const serverCalls = run.toolCalls.filter((call) => call.outcome.ok && call.outcome.mode === "server").length;
      const toolCoverage = run.toolCalls.length === 0 || serverCalls > 0;
      observation = {
        ...observation,
        taskId: task.id,
        title: task.title,
        passed: localScore.passed && remoteScore.passed && toolCoverage,
        packageKey,
        draftId,
        seeded,
        stored,
        localScore,
        remoteScore,
        ...(options.model
          ? {
              fixtureComparison: {
                description:
                  "Unchanged deterministic fixture oracle applied to this new live contract; historical runs remain separate.",
                localScore: scoreEvalRun({ ...run, task: fixtureTask }),
                remoteScore: scoreEvalRun({ ...run, task: fixtureTask, state: remoteState }),
              },
            }
          : {}),
        serverCalls,
        toolCoverage,
        run,
        modelEvents: driver instanceof LiveTurnDriver ? driver.events : undefined,
        modelMessages: driver instanceof LiveTurnDriver ? driver.session.messages : undefined,
      };
    } catch (error) {
      observation.error = error instanceof Error ? error.message : String(error);
      if (modelTrafficStart !== undefined) modelTraffic = transcript.slice(modelTrafficStart);
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
      perTurnReadbacks,
      ...(options.model
        ? {
            liveSemanticScore:
              semanticRun && semanticInitial
                ? await applyAuthoritativeStyleEvidence(
                    scoreLiveSemanticRun({
                      run: semanticRun,
                      initial: semanticInitial,
                      observations: perTurnReadbacks,
                      cleanupPassed: cleanup.passed === true,
                      lifecycleWrites: modelTraffic.filter(isLifecycleWrite),
                    }),
                    options.styleRequirements?.[task.id],
                    perTurnReadbacks.at(-1)?.styles,
                    semanticRun.state,
                  )
                : {
                    schemaVersion: "honua.studio.live-semantic-score.v1",
                    taskId: task.id,
                    status: "fail",
                    passed: false,
                    checks: [
                      {
                        path: "execution.completed",
                        status: "fail",
                        expected: true,
                        actual: observation.error ?? "No run result",
                      },
                    ],
                  },
          }
        : {}),
    });
    const entry = cases.at(-1);
    if (entry && options.model) entry.passed = entry.passed && entry.liveSemanticScore?.passed === true;
  }
  return {
    schemaVersion: "honua.studio.server-corpus.v1",
    mode: options.model ? "live-model-real-mcp" : "scripted-real-mcp",
    taskContract: options.model ? LIVE_EXACT_CONTRACT : "deterministic-fixture",
    modelQualityEvaluated: Boolean(options.model),
    model: options.model
      ? { provider: options.model.provider, model: options.model.model, manifest: options.model.manifest }
      : undefined,
    releaseQualification: false,
    runId: options.runId,
    baseUrl,
    observedAt: new Date().toISOString(),
    sources: options.sources,
    styleRequirements: options.styleRequirements,
    passed: cases.every((entry) => entry.passed),
    ...(options.model
      ? {
          semanticSummary: {
            passed: cases.filter((entry) => entry.liveSemanticScore?.status === "pass").length,
            failed: cases.filter((entry) => entry.liveSemanticScore?.status === "fail").length,
            prerequisiteUnmet: cases.filter((entry) => entry.liveSemanticScore?.status === "prerequisite-unmet").length,
            total: cases.length,
          },
        }
      : {}),
    cases,
  };
}

interface CorpusExchange {
  url: string;
  method: string;
  request?: unknown;
  status: number;
  response: string;
}

/** Audits only the model-turn window: owned setup/deletion are outside it. */
function isLifecycleWrite(exchange: CorpusExchange): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(exchange.method)) return false;
  const path = new URL(exchange.url).pathname;
  if (path.includes("/v1/studio/") && !path.endsWith("/ai/chat")) return true;
  const request = exchange.request as { method?: string; params?: { name?: string } } | undefined;
  return (
    request?.method === "tools/call" &&
    /^honua_studio_(?:create_draft|update_draft|save_version|publish|request_publish|approve|rollback|delete)/.test(
      request.params?.name ?? "",
    )
  );
}
