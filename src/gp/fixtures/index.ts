import type { StudioMcpDraft, StudioMcpPreviewPlan, StudioMcpValidationSummary } from "../../mcp/studio-tools.js";
/**
 * The deterministic GP authoring conversation runner (honua-studio#10
 * NFR-001) — the agent half of the scripted journey. See
 * `buffer-intersect-statewide.ts`'s module doc for why the human half
 * (confirm/execute/complete/add-output-layer) is deliberately NOT part of
 * this runner.
 *
 * @module
 */
import type { GpAuthoringSession } from "../gp-authoring-session.js";
import {
  BUFFER_INTERSECT_DESCRIPTION,
  BUFFER_INTERSECT_INPUTS,
  BUFFER_INTERSECT_OUTPUTS,
  BUFFER_INTERSECT_PACKAGE_KEY,
  BUFFER_INTERSECT_PARAMETERS,
  BUFFER_INTERSECT_RERUN_PARAMETERS,
  BUFFER_INTERSECT_STEPS,
  BUFFER_INTERSECT_TITLE,
} from "./buffer-intersect-statewide.js";

export {
  BUFFER_INTERSECT_DESCRIPTION,
  BUFFER_INTERSECT_INPUTS,
  BUFFER_INTERSECT_OUTPUTS,
  BUFFER_INTERSECT_PACKAGE_KEY,
  BUFFER_INTERSECT_PARAMETERS,
  BUFFER_INTERSECT_RERUN_PARAMETERS,
  BUFFER_INTERSECT_STEPS,
  BUFFER_INTERSECT_TITLE,
} from "./buffer-intersect-statewide.js";

export interface GpFixtureAuthoringStepResult {
  readonly action: string;
  readonly draft: StudioMcpDraft;
}

export interface GpFixtureAuthoringResult {
  readonly steps: readonly GpFixtureAuthoringStepResult[];
  readonly draft: StudioMcpDraft;
  readonly validation: StudioMcpValidationSummary;
  readonly preview: StudioMcpPreviewPlan;
}

/**
 * Runs the full author -> validate -> preview trail against a REAL
 * {@link GpAuthoringSession} (backed by a real `McpClient` +
 * `mock-server.mjs` in every test that calls this): create the draft, add
 * both inputs, the buffer-distance parameter, and the output, then validate
 * and preview-plan. Every step is `await`ed in order — no timers, no
 * randomness, byte-stable across runs (module doc's NFR-001 claim).
 */
export async function runGpFixtureAuthoring(session: GpAuthoringSession): Promise<GpFixtureAuthoringResult> {
  const steps: GpFixtureAuthoringStepResult[] = [];

  const created = await session.createDraft(BUFFER_INTERSECT_TITLE, BUFFER_INTERSECT_DESCRIPTION);
  steps.push({ action: "createDraft", draft: created });

  for (const input of BUFFER_INTERSECT_INPUTS) {
    const draft = await session.addInput(input);
    steps.push({ action: `addInput:${input.id}`, draft });
  }
  for (const parameter of BUFFER_INTERSECT_PARAMETERS) {
    const draft = await session.addParameter(parameter);
    steps.push({ action: `addParameter:${parameter.id}`, draft });
  }
  for (const output of BUFFER_INTERSECT_OUTPUTS) {
    const draft = await session.addOutput(output);
    steps.push({ action: `addOutput:${output.id}`, draft });
  }

  const validation = await session.validate();
  const preview = await session.previewPlan();
  const draft = session.draft;
  if (!draft) throw new Error("runGpFixtureAuthoring: session has no draft after authoring — unreachable.");
  return { steps, draft, validation, preview };
}
