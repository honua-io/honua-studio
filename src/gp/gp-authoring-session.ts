/**
 * Conversational GP authoring (honua-studio#10 build item 2) — the GP
 * analog of `mcp/orchestrator.ts`, scoped to the draft-authoring surface
 * instead of composition mutation. The agent authors a `gp`-family package
 * by REUSING the existing generic `honua_studio_create_draft` /
 * `honua_studio_update_draft` / `honua_studio_validate_draft` /
 * `honua_studio_preview_draft` tools (`mcp/studio-tools.ts`,
 * honua-server#3002) — no new MCP tool names or wire vocabulary. Those four
 * tools are already family-agnostic server-side (unlike
 * `honua_studio_add_layer` and friends, which `mock-server.mjs`'s
 * `ensureCompositionEligible` restricts to `map`/`app` — see
 * `mcp/tool-bridge.ts`'s module doc): this session sends `gp`-shaped
 * envelope bodies (`gp-types.ts`'s `GpPackageBody`) through them instead of
 * a `StudioCompositionBody`.
 *
 * This session is intentionally MCP-only (`StudioMcpToolClient`, never
 * `StudioLifecycleClient` and never `GpJobClient`) — it is the agent's
 * entire reach into GP authoring. It cannot validate anything the real
 * server doesn't (see `gp-types.ts`'s honesty note), and it structurally
 * cannot submit a job: `GpJobClient` is not imported here at all, and there
 * is no method on this class that could reach one — see
 * `job-client.ts`'s "THE HUMAN GATE" section and `test/gp/human-gate.test.ts`.
 *
 * @module
 */
import type {
  StudioMcpDraft,
  StudioMcpPreviewPlan,
  StudioMcpToolClient,
  StudioMcpValidationSummary,
} from "../mcp/studio-tools.js";
import { addGpInput, addGpOutput, addGpParameter, setGpParameterValue } from "./gp-model.js";
import type { GpPackageBody, GpPackageInput, GpPackageOutput, GpPackageParameter } from "./gp-types.js";

export interface GpAuthoringSessionOptions {
  readonly tools: StudioMcpToolClient;
  readonly packageKey: string;
  readonly schemaVersion?: string;
}

/**
 * Owns one `gp`-family draft's authoring lifecycle over the MCP draft
 * tools: create -> mutate body (add input/parameter/output) -> validate ->
 * preview-plan. Every method returns the draft/summary the server actually
 * returned — never a locally-derived guess (same "read back what it says
 * happened" discipline `mcp/orchestrator.ts`'s module doc documents for the
 * composition path).
 */
export class GpAuthoringSession {
  readonly #tools: StudioMcpToolClient;
  readonly #packageKey: string;
  readonly #schemaVersion: string;
  #draft: StudioMcpDraft | undefined;
  #body: GpPackageBody | undefined;

  public constructor(options: GpAuthoringSessionOptions) {
    this.#tools = options.tools;
    this.#packageKey = options.packageKey;
    this.#schemaVersion = options.schemaVersion ?? "1.0";
  }

  /** The most recently returned draft, or `undefined` before {@link createDraft}. */
  public get draft(): StudioMcpDraft | undefined {
    return this.#draft;
  }

  /** This session's own last-known body — kept in sync with every server round trip so the next mutation always starts from what the server actually has. */
  public get body(): GpPackageBody | undefined {
    return this.#body;
  }

  /** Creates the draft (`honua_studio_create_draft`, family `"gp"`) with an initial empty body. */
  public async createDraft(title: string, description?: string): Promise<StudioMcpDraft> {
    const body: GpPackageBody = {
      title,
      ...(description !== undefined ? { description } : {}),
      inputs: [],
      parameters: [],
      outputs: [],
      steps: [],
    };
    const draft = await this.#tools.createDraft({
      packageKey: this.#packageKey,
      family: "gp",
      schemaVersion: this.#schemaVersion,
      body,
    });
    this.#draft = draft;
    this.#body = body;
    return draft;
  }

  public async addInput(input: GpPackageInput): Promise<StudioMcpDraft> {
    return this.#mutate((body) => addGpInput(body, input));
  }

  public async addParameter(parameter: GpPackageParameter): Promise<StudioMcpDraft> {
    return this.#mutate((body) => addGpParameter(body, parameter));
  }

  /** REQ-005: re-authoring a saved package's parameter value before a fresh preview+submit. */
  public async setParameterValue(parameterId: string, value: unknown): Promise<StudioMcpDraft> {
    return this.#mutate((body) => setGpParameterValue(body, parameterId, value));
  }

  public async addOutput(output: GpPackageOutput): Promise<StudioMcpDraft> {
    return this.#mutate((body) => addGpOutput(body, output));
  }

  /** `honua_studio_validate_draft` — envelope-only server-side (see `gp-model.ts`'s `gpValidationCaveat`). */
  public async validate(): Promise<StudioMcpValidationSummary> {
    const draft = this.#requireDraft();
    return this.#tools.validateDraft(draft.draftId);
  }

  /** `honua_studio_preview_draft` — planning-only for a job-backed family (see `gp-types.ts`'s module doc); does not execute anything. */
  public async previewPlan(): Promise<StudioMcpPreviewPlan> {
    const draft = this.#requireDraft();
    return this.#tools.previewDraft(draft.draftId);
  }

  async #mutate(next: (body: GpPackageBody) => GpPackageBody): Promise<StudioMcpDraft> {
    const draft = this.#requireDraft();
    const body = next(this.#body ?? emptyBodyFromDraft(draft));
    const updated = await this.#tools.updateDraft({
      draftId: draft.draftId,
      generation: draft.generation,
      packageKey: draft.packageKey,
      schemaVersion: draft.envelope.schemaVersion,
      body,
    });
    this.#draft = updated;
    this.#body = body;
    return updated;
  }

  #requireDraft(): StudioMcpDraft {
    if (!this.#draft) throw new Error("GpAuthoringSession: no draft created yet — call createDraft() first.");
    return this.#draft;
  }
}

function emptyBodyFromDraft(draft: StudioMcpDraft): GpPackageBody {
  const body = draft.envelope.body as Partial<GpPackageBody> | undefined;
  return {
    title: body?.title ?? draft.packageKey,
    ...(body?.description !== undefined ? { description: body.description } : {}),
    inputs: body?.inputs ?? [],
    parameters: body?.parameters ?? [],
    outputs: body?.outputs ?? [],
    steps: body?.steps ?? [],
  };
}
