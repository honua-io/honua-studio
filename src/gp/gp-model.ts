/**
 * Pure, structural helpers over {@link GpPackageBody} — the GP analog of
 * `composition/model.ts` + `composition/commands.ts`: builders/mutators are
 * plain functions that return a new body (never mutate in place), and
 * {@link validateGpPackageBody} is a hand-rolled structural check (no
 * schema-validation dependency, matching this repo's established
 * `commands.ts` convention) that catches obviously malformed authoring
 * BEFORE it round-trips to the server.
 *
 * That client-side check is deliberately NOT the same thing as server
 * validation, and this module says so out loud: honua-server's GP support
 * is envelope-only (see `gp-types.ts`'s module doc) — it never inspects the
 * operation graph, parameter types, or dataset refs this module's checks
 * DO look at. {@link gpValidationCaveat} is the one canonical string
 * `<honua-studio-gp-panel>` renders so the UI is never dishonest about how
 * deep either check actually goes.
 *
 * @module
 */
import type { GpPackageBody, GpPackageInput, GpPackageOutput, GpPackageParameter, GpPackageStep } from "./gp-types.js";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function createEmptyGpPackageBody(title: string, description?: string): GpPackageBody {
  return {
    title,
    ...(description !== undefined ? { description } : {}),
    inputs: [],
    parameters: [],
    outputs: [],
    steps: [],
  };
}

export function addGpInput(body: GpPackageBody, input: GpPackageInput): GpPackageBody {
  if (body.inputs.some((existing) => existing.id === input.id)) {
    throw new GpModelError(`An input with id "${input.id}" already exists.`);
  }
  return { ...body, inputs: [...body.inputs, input] };
}

export function removeGpInput(body: GpPackageBody, inputId: string): GpPackageBody {
  return { ...body, inputs: body.inputs.filter((existing) => existing.id !== inputId) };
}

export function addGpParameter(body: GpPackageBody, parameter: GpPackageParameter): GpPackageBody {
  if (body.parameters.some((existing) => existing.id === parameter.id)) {
    throw new GpModelError(`A parameter with id "${parameter.id}" already exists.`);
  }
  return { ...body, parameters: [...body.parameters, parameter] };
}

/** Sets an existing parameter's value in place (id unchanged) — the primitive REQ-005's "re-run with new parameters" authoring step uses before a fresh submit. */
export function setGpParameterValue(body: GpPackageBody, parameterId: string, value: unknown): GpPackageBody {
  const index = body.parameters.findIndex((existing) => existing.id === parameterId);
  if (index < 0) throw new GpModelError(`No parameter with id "${parameterId}" exists.`);
  const parameters = [...body.parameters];
  const current = parameters[index];
  if (!current) throw new GpModelError(`No parameter with id "${parameterId}" exists.`);
  parameters[index] = { ...current, value };
  return { ...body, parameters };
}

export function removeGpParameter(body: GpPackageBody, parameterId: string): GpPackageBody {
  return { ...body, parameters: body.parameters.filter((existing) => existing.id !== parameterId) };
}

export function addGpOutput(body: GpPackageBody, output: GpPackageOutput): GpPackageBody {
  if (body.outputs.some((existing) => existing.id === output.id)) {
    throw new GpModelError(`An output with id "${output.id}" already exists.`);
  }
  return { ...body, outputs: [...body.outputs, output] };
}

export function removeGpOutput(body: GpPackageBody, outputId: string): GpPackageBody {
  return { ...body, outputs: body.outputs.filter((existing) => existing.id !== outputId) };
}

export function setGpSteps(body: GpPackageBody, steps: readonly GpPackageStep[]): GpPackageBody {
  return { ...body, steps };
}

export class GpModelError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GpModelError";
  }
}

// ---------------------------------------------------------------------------
// Structural validation (client-side, pre-round-trip — see the module doc)
// ---------------------------------------------------------------------------

export interface GpPackageBodyValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/**
 * Structural-only check: non-empty title, unique ids within each of
 * inputs/parameters/outputs/steps, every `steps[].dependsOn` resolves to
 * another step id, at least one output declared (a GP package with no
 * output has nothing REQ-004 could ever register as a catalog dataset).
 * Never throws; returns every problem found, not just the first.
 */
export function validateGpPackageBodyStructurally(body: GpPackageBody): GpPackageBodyValidation {
  const errors: string[] = [];
  if (!body.title || body.title.trim().length === 0) errors.push("title must be a non-empty string.");
  errors.push(...duplicateIdErrors(body.inputs, "inputs"));
  errors.push(...duplicateIdErrors(body.parameters, "parameters"));
  errors.push(...duplicateIdErrors(body.outputs, "outputs"));
  errors.push(...duplicateIdErrors(body.steps, "steps"));
  if (body.outputs.length === 0) {
    errors.push(
      "at least one output must be declared — a package with no output has nothing to register as a catalog dataset.",
    );
  }
  const stepIds = new Set(body.steps.map((step) => step.id));
  for (const step of body.steps) {
    for (const dependency of step.dependsOn ?? []) {
      if (!stepIds.has(dependency)) {
        errors.push(`step "${step.id}" depends on unknown step "${dependency}".`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function duplicateIdErrors(entries: readonly { readonly id: string }[], label: string): string[] {
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) errors.push(`duplicate ${label} id "${entry.id}".`);
    seen.add(entry.id);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// The honesty caveat (REQ-006-adjacent — see gp-types.ts's module doc)
// ---------------------------------------------------------------------------

/**
 * The ONE canonical honest-validation caveat string this app renders
 * anywhere a GP draft's validation/preview state is shown. Deliberately a
 * single exported constant-returning function (not inlined per call site)
 * so the wording can never drift between the panel's validation section and
 * its preview-plan section.
 */
export function gpValidationCaveat(): string {
  return (
    "honua-server's GP support is limited today: validation is envelope-only " +
    "(the envelope's shape is checked; the operation graph, parameter types, " +
    "and dataset refs below are not independently verified by the server), " +
    "and preview-plan for GP is planning-only — it reports the steps a real " +
    "execution would take without running any of them."
  );
}
