import { type HonuaStyleRefBody, styleDocumentToRefBody } from "@honua/sdk-js/runtime";
import type { HonuaStyleSpecification } from "@honua/sdk-js/style";
import type { CompositionStyleLayerBinding } from "./map-style-edit.js";

/** Use the SDK's canonical mapper; retain published older SDKs for unbound standalone documents. */
export function canonicalStyleRefBody(
  document: HonuaStyleSpecification,
  bindings?: readonly CompositionStyleLayerBinding[],
): HonuaStyleRefBody {
  if (bindings !== undefined && styleDocumentToRefBody.length < 2)
    throw new Error(
      "Explicit shared style bindings require the qualified binding-aware SDK. Reopen in the unified workspace.",
    );
  // The optional second parameter is newer than the standalone published SDK's
  // declarations. Console builds pin every package file to the reviewed pack.
  const project = styleDocumentToRefBody as (
    style: HonuaStyleSpecification,
    bindings?: readonly CompositionStyleLayerBinding[],
  ) => HonuaStyleRefBody;
  return project(document, bindings);
}
