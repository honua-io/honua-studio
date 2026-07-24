/**
 * Public entry point for conversational GP authoring + async batch
 * execution (honua-studio#10). Side-effect-free on import, like every other
 * barrel in this package.
 *
 * @module
 */

export type {
  GpJobError,
  GpJobOutputRef,
  GpJobProgress,
  GpJobResult,
  GpJobSnapshot,
  GpJobStatus,
  GpJobSubmitInput,
  GpPackageBody,
  GpPackageInput,
  GpPackageOutput,
  GpPackageParameter,
  GpPackageStep,
  GpParameterType,
} from "./gp-types.js";
export { isGpJobTerminal } from "./gp-types.js";

export type { GpPackageBodyValidation } from "./gp-model.js";
export {
  GpModelError,
  addGpInput,
  addGpOutput,
  addGpParameter,
  createEmptyGpPackageBody,
  gpValidationCaveat,
  removeGpInput,
  removeGpOutput,
  removeGpParameter,
  setGpParameterValue,
  setGpSteps,
  validateGpPackageBodyStructurally,
} from "./gp-model.js";

export type { GpJobClient, GpJobClientErrorCode, StudioGpJobClientOptions, TokenSource } from "./job-client.js";
export { GpJobClientError, StudioGpJobClient, isGpJobNotFound } from "./job-client.js";

export type { GpAuthoringSessionOptions } from "./gp-authoring-session.js";
export { GpAuthoringSession } from "./gp-authoring-session.js";

export type { GpFixtureAuthoringResult, GpFixtureAuthoringStepResult } from "./fixtures/index.js";
export {
  BUFFER_INTERSECT_DESCRIPTION,
  BUFFER_INTERSECT_INPUTS,
  BUFFER_INTERSECT_OUTPUTS,
  BUFFER_INTERSECT_PACKAGE_KEY,
  BUFFER_INTERSECT_PARAMETERS,
  BUFFER_INTERSECT_RERUN_PARAMETERS,
  BUFFER_INTERSECT_STEPS,
  BUFFER_INTERSECT_TITLE,
  runGpFixtureAuthoring,
} from "./fixtures/index.js";
