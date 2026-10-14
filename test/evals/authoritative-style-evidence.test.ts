import { describe, expect, it } from "vitest";
import { canonicalCompositionJson, createEmptyCompositionState } from "../../src/composition/model.js";
import {
  type LiveStyleObservation,
  type LiveStyleRequirement,
  applyAuthoritativeStyleEvidence,
} from "../../src/evals/authoritative-style-evidence.js";
import type { LiveSemanticScore } from "../../src/evals/live-semantic-scorer.js";
import { styleContentHash } from "../../src/styles/authoritative-style-provider.js";

const prerequisite: LiveSemanticScore = {
  schemaVersion: "honua.studio.live-semantic-score.v1",
  taskId: "compose-districts-map",
  status: "prerequisite-unmet",
  passed: false,
  checks: [
    {
      path: "prerequisites.authoritativeStyleDefinitions",
      status: "prerequisite-unmet",
      expected: "actual definitions",
      actual: "missing",
    },
  ],
};
const requirement: LiveStyleRequirement = {
  sourceId: "service/0",
  serverRoot: "https://honua.test/honua",
  classificationField: "district",
  description: "Classify by actual district field.",
};
async function fixture() {
  const paint = { "fill-color": ["match", ["get", "district"], "North", "#003366", "#ddaa22"] };
  const layer = { id: "canonical", type: "fill", source: "parcels", paint };
  const inlineBody = JSON.stringify({
    version: 8,
    sources: { parcels: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
    layers: [layer],
  });
  const sha256 = await styleContentHash(inlineBody);
  const descriptorBody = canonicalCompositionJson({ serviceId: "service", layerId: 0, fields: [{ name: "district" }] });
  const metadata = {
    "honua:styleId": "district",
    "honua:styleVersion": 1,
    "honua:styleSha256": sha256,
    "honua:styleServer": requirement.serverRoot,
  };
  const observation: LiveStyleObservation = {
    layerId: "parcels",
    sourceId: "service/0",
    styleId: "district",
    renderedFeatureCount: 12,
    binding: {
      sourceId: "service/0",
      stylesheetLayerId: "canonical",
      fields: ["district"],
      descriptorBody,
      descriptorSha256: await styleContentHash(descriptorBody),
      override: { paint, metadata },
      definition: {
        styleId: "district",
        title: "District",
        description: "North navy, other gold",
        styleVersion: 1,
        sha256,
        inlineBody,
        serverRoot: requirement.serverRoot,
        observedAt: "2026-10-14T00:00:00Z",
        layers: [layer],
      },
    },
    renderedLayer: { id: "parcels", type: "fill", source: "service/0", paint, metadata },
  };
  const composition = {
    ...createEmptyCompositionState(),
    layers: [{ id: "parcels", sourceId: "service/0", visible: true, styleRef: { styleId: "district" } }],
  };
  return { observation, composition };
}

describe("actual style semantics supplement", () => {
  it("preserves prerequisite-unmet without actual runtime observations or explicit requirements", async () => {
    const { observation, composition } = await fixture();
    expect(await applyAuthoritativeStyleEvidence(prerequisite, requirement, undefined, composition)).toEqual(
      prerequisite,
    );
    expect(await applyAuthoritativeStyleEvidence(prerequisite, undefined, [observation], composition)).toEqual(
      prerequisite,
    );
  });
  it("accepts hash-bound definition, actual descriptor field and corresponding runtime paint", async () => {
    const { observation, composition } = await fixture();
    expect((await applyAuthoritativeStyleEvidence(prerequisite, requirement, [observation], composition)).status).toBe(
      "pass",
    );
  });
  it.each([
    "hash",
    "revision",
    "field",
    "palette",
    "unrendered",
    "source",
    "layer",
    "origin",
    "rendered-source",
    "filter",
  ])("rejects %s mismatch", async (kind) => {
    const { observation: original, composition } = await fixture();
    const observation = structuredClone(original);
    let expected = requirement;
    if (kind === "hash") (observation.renderedLayer.metadata as Record<string, unknown>)["honua:styleSha256"] = "stale";
    if (kind === "revision") (observation.renderedLayer.metadata as Record<string, unknown>)["honua:styleVersion"] = 0;
    if (kind === "field") expected = { ...requirement, classificationField: "imaginary" };
    if (kind === "palette")
      expected = { ...requirement, classificationField: undefined, palette: { "fill-color": "#ff0000" } };
    if (kind === "unrendered") Object.assign(observation, { renderedFeatureCount: 0 });
    if (kind === "rendered-source") Object.assign(observation.renderedLayer, { source: "different-data" });
    if (kind === "filter") Object.assign(observation.renderedLayer, { filter: ["==", ["get", "district"], "hidden"] });
    if (kind === "source") Object.assign(observation.binding, { sourceId: "other" });
    if (kind === "layer") Object.assign(observation.renderedLayer, { id: "other" });
    if (kind === "origin") expected = { ...requirement, serverRoot: "https://other.test" };
    expect((await applyAuthoritativeStyleEvidence(prerequisite, expected, [observation], composition)).status).toBe(
      "fail",
    );
  });
  it("rejects a modified stylesheet despite a previously valid claimed hash", async () => {
    const { observation, composition } = await fixture();
    Object.assign(observation.binding.definition, {
      inlineBody: observation.binding.definition.inlineBody.replace("district", "zoning"),
    });
    expect((await applyAuthoritativeStyleEvidence(prerequisite, requirement, [observation], composition)).status).toBe(
      "fail",
    );
  });
  it("cannot clear an unrelated strict semantic failure", async () => {
    const { observation, composition } = await fixture();
    const score: LiveSemanticScore = {
      ...prerequisite,
      checks: [...prerequisite.checks, { path: "pins", status: "fail", expected: [], actual: ["changed"] }],
    };
    expect((await applyAuthoritativeStyleEvidence(score, requirement, [observation], composition)).status).toBe("fail");
  });
});
