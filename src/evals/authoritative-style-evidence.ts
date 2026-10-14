import { type CompositionState, canonicalCompositionJson } from "../composition/model.js";
import {
  type BoundAuthoritativeStyle,
  parseStyleLayers,
  styleContentHash,
} from "../styles/authoritative-style-provider.js";
import { compositionStyleOverride } from "../styles/composition-style-override.js";
import type { LiveSemanticCheck, LiveSemanticScore } from "./live-semantic-scorer.js";

/** Explicit user-readable requirements; neither field nor palette is inferred from a style id. */
export interface LiveStyleRequirement {
  readonly sourceId: string;
  readonly serverRoot: string;
  readonly classificationField?: string;
  readonly palette?: Readonly<Record<string, unknown>>;
  readonly description: string;
}
export interface LiveStyleObservation {
  readonly layerId: string;
  readonly sourceId: string;
  readonly styleId: string;
  readonly binding: BoundAuthoritativeStyle;
  /** Read from the actual MapLibre map, never the intended projection. */
  readonly renderedLayer: Readonly<Record<string, unknown>>;
  readonly renderedFeatureCount: number;
  readonly appearance?: { readonly filter?: unknown; readonly opacity?: number };
}

/** Supplements the existing strict score; it cannot turn unrelated failures into passes. */
export async function applyAuthoritativeStyleEvidence(
  score: LiveSemanticScore,
  requirement: LiveStyleRequirement | undefined,
  observations: readonly LiveStyleObservation[] | undefined,
  composition: CompositionState,
): Promise<LiveSemanticScore> {
  if (!score.checks.some((check) => check.path === "prerequisites.authoritativeStyleDefinitions")) return score;
  if (
    !requirement ||
    !requirement.description ||
    (!requirement.classificationField && Object.keys(requirement.palette ?? {}).length === 0) ||
    !observations?.length
  )
    return score;
  const checks: LiveSemanticCheck[] = score.checks.filter(
    (check) => check.path !== "prerequisites.authoritativeStyleDefinitions",
  );
  const check = (path: string, expected: unknown, actual: unknown) =>
    checks.push({
      path: `styles.${path}`,
      expected,
      actual,
      status: canonicalCompositionJson(expected) === canonicalCompositionJson(actual) ? "pass" : "fail",
    });
  const candidates = observations.filter((entry) => entry.sourceId === requirement.sourceId);
  check("target.count", 1, candidates.length);
  const observation = candidates[0];
  if (observation) {
    try {
      const { binding, renderedLayer } = observation;
      const composed = composition.layers.find((layer) => layer.id === observation.layerId);
      check("composition.source", requirement.sourceId, composed?.sourceId);
      check("composition.style", observation.styleId, composed?.styleRef?.styleId);
      const definition = binding.definition;
      check("definition.server", requirement.serverRoot, definition.serverRoot);
      check("definition.revision", true, Number.isSafeInteger(definition.styleVersion) && definition.styleVersion >= 0);
      check("definition.hash", definition.sha256, await styleContentHash(definition.inlineBody));
      check("descriptor.hash", binding.descriptorSha256, await styleContentHash(binding.descriptorBody));
      check("source.identity", requirement.sourceId, binding.sourceId);
      check("style.identity", observation.styleId, definition.styleId);
      check("layer.identity", observation.layerId, renderedLayer.id);
      check("rendered.source", binding.sourceId, renderedLayer.source);
      check("rendered.features", true, observation.renderedFeatureCount > 0);
      const metadata = renderedLayer.metadata as Record<string, unknown> | undefined;
      for (const [key, expected] of Object.entries({
        styleId: definition.styleId,
        styleVersion: definition.styleVersion,
        styleSha256: definition.sha256,
        styleServer: definition.serverRoot,
      }))
        check(`provenance.${key}`, expected, metadata?.[`honua:${key}`]);
      const selected = parseStyleLayers(definition.inlineBody).filter(
        (layer) => layer.id === binding.stylesheetLayerId,
      );
      check("stylesheet.layer", 1, selected.length);
      const styleLayer = selected[0];
      if (styleLayer) {
        check("rendered.type", styleLayer.type, renderedLayer.type);
        const expected = compositionStyleOverride(
          {
            paint: styleLayer.paint as Record<string, unknown> | undefined,
            layout: styleLayer.layout as Record<string, unknown> | undefined,
            filter: styleLayer.filter,
            minzoom: styleLayer.minzoom as number | undefined,
            maxzoom: styleLayer.maxzoom as number | undefined,
          },
          String(styleLayer.type),
          composed?.visible ?? false,
          observation.appearance,
        );
        check("rendered.layout", expected.layout ?? {}, renderedLayer.layout ?? {});
        check("rendered.filter", expected.filter, renderedLayer.filter);
        check("rendered.minzoom", expected.minzoom ?? 0, renderedLayer.minzoom ?? 0);
        check("rendered.maxzoom", expected.maxzoom ?? 24, renderedLayer.maxzoom ?? 24);
        const paint = renderedLayer.paint as Record<string, unknown> | undefined;
        for (const [key, expected] of Object.entries(expected.paint ?? {}))
          check(`rendered.paint.${key}`, expected, paint?.[key]);
        if (requirement.classificationField) {
          const descriptor = JSON.parse(binding.descriptorBody) as { fields?: Array<{ name?: string }> };
          check(
            "classification.descriptor",
            true,
            descriptor.fields?.some((field) => field.name === requirement.classificationField) === true,
          );
          const color = (styleLayer.paint as Record<string, unknown> | undefined)?.[`${styleLayer.type}-color`];
          const method = Array.isArray(color) ? color[0] : undefined;
          const input = Array.isArray(color) ? color[method === "interpolate" ? 2 : 1] : undefined;
          const outputs = Array.isArray(color)
            ? color.filter((_, index) =>
                method === "match"
                  ? (index >= 3 && index % 2 === 1) || index === color.length - 1
                  : method === "step"
                    ? index >= 2 && index % 2 === 0
                    : method === "interpolate"
                      ? index >= 4 && index % 2 === 0
                      : false,
              )
            : [];
          check(
            "classification.expression",
            true,
            ["match", "step", "interpolate"].includes(String(method)) &&
              canonicalCompositionJson(input) === canonicalCompositionJson(["get", requirement.classificationField]) &&
              new Set(outputs.map(canonicalCompositionJson)).size >= 2,
          );
        }
        for (const [key, expected] of Object.entries(requirement.palette ?? {}))
          check(`palette.${key}`, expected, (styleLayer.paint as Record<string, unknown> | undefined)?.[key]);
      }
    } catch (error) {
      check("definition.valid", true, error instanceof Error ? error.message : String(error));
    }
  }
  const status = checks.some((entry) => entry.status === "fail")
    ? "fail"
    : checks.some((entry) => entry.status === "prerequisite-unmet")
      ? "prerequisite-unmet"
      : "pass";
  return { ...score, checks, status, passed: status === "pass" };
}
