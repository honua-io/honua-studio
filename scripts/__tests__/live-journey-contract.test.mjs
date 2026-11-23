import assert from "node:assert/strict";
import { test } from "node:test";
import { liveReadinessEvidence, selectLiveModel } from "../../test/playwright/live-journey-contract.mjs";
import { liveMcpFixture, resolveMcpFixture, selectMcpFixtureSource } from "../../test/playwright/live-mcp-fixture.mjs";

const opus = {
  provider: "opus",
  kind: "anthropic",
  model: "claude-opus-5-5",
  configured: true,
  streaming: true,
  isDefault: true,
};

test("live model selection refuses unsupported adapters, models and unavailable providers", () => {
  for (const override of [
    { kind: "bedrock" },
    { model: "claude-sonnet-4-5" },
    { model: "claude-opus-4-6" },
    { configured: false },
    { streaming: false },
  ]) {
    assert.throws(() => selectLiveModel({ enabled: true, providers: [{ ...opus, ...override }] }));
  }
  assert.throws(() => selectLiveModel({ enabled: false, providers: [opus] }));
  assert.throws(() => selectLiveModel({ enabled: true, providers: [] }));
});

test("live model selection chooses an approved configured provider without using a disallowed default", () => {
  const sol = { ...opus, provider: "sol", kind: "openai", model: "gpt-6.1-sol", isDefault: false };
  assert.equal(selectLiveModel({ enabled: true, providers: [opus, sol] }), opus);
  assert.equal(selectLiveModel({ enabled: true, providers: [{ ...opus, kind: "bedrock" }, sol] }), sol);
});

test("tool model selection prefers a capable approved provider over an incompatible default", () => {
  const toolProvider = { ...opus, provider: "tools", toolSupport: true, isDefault: false };
  assert.equal(
    selectLiveModel({ enabled: true, providers: [{ ...opus, toolSupport: false }, toolProvider] }, [
      "streaming",
      "toolSupport",
    ]),
    toolProvider,
  );
  assert.throws(() => selectLiveModel({ enabled: false }));
});

test("readiness evidence excludes provider identities, model identifiers, signing material and credentials", () => {
  const capabilities = {
    enabled: true,
    defaultProvider: "private-provider-name",
    transcriptSigning: { keys: ["private-signing-metadata"] },
    providers: [{ ...opus, credential: "private-provider-credential", toolSupport: true }],
  };
  const evidence = liveReadinessEvidence(capabilities, { consoleApprovalConfigured: true });
  assert.deepEqual(evidence, {
    enabled: true,
    approvedProviderAvailable: true,
    providers: [{ kind: "anthropic", configured: true, streaming: true, toolSupport: true, isDefault: true }],
    consoleApprovalConfigured: true,
  });
  assert.equal(liveReadinessEvidence({ enabled: false }, {}).approvedProviderAvailable, false);
  assert.equal(
    liveReadinessEvidence({ enabled: true, providers: [{ ...opus, kind: "bedrock" }] }, {}).approvedProviderAvailable,
    false,
  );
});

const candidateSource = {
  id: "synthetic-points/0",
  title: "Synthetic points",
  protocol: "geoservices-feature-service",
  geometryType: "esriGeometryPoint",
  locator: { url: "/rest/services/synthetic/FeatureServer", layerId: 0 },
};

test("scripted MCP turns bind to the candidate catalog and actual layer fields", () => {
  const source = selectMcpFixtureSource([{ ...candidateSource, protocol: "wms" }, candidateSource]);
  const fixture = liveMcpFixture(source, {
    id: 0,
    fields: [
      { name: "Shape", type: "esriFieldTypeGeometry" },
      { name: "category", type: "esriFieldTypeString" },
    ],
  });
  assert.equal(fixture.datasetId, "synthetic-points/0");
  assert.equal(fixture.chartId, "chart-synthetic-points/0-category");
  assert.deepEqual(
    fixture.turns.map((turn) => turn.args),
    [
      { datasetId: source.id, sourceId: source.id },
      { datasetId: source.id, sourceId: source.id, groupBy: "category", chartType: "bar" },
    ],
  );
  assert.doesNotMatch(JSON.stringify(fixture), /hi-parcels|district|zoning_code/);
});

test("scripted MCP setup fails clearly without a usable catalog or matching field metadata", () => {
  for (const catalog of [[], [{ ...candidateSource, locator: {} }], [{ ...candidateSource, geometryType: "Raster" }]]) {
    assert.throws(() => selectMcpFixtureSource(catalog), /published vector FeatureServer/);
  }
  for (const metadata of [
    { id: 1, fields: [{ name: "category" }] },
    { id: 0, fields: [] },
    { id: 0, fields: [{ name: "Shape", type: "esriFieldTypeGeometry" }] },
    { id: 0, error: { code: 403 }, fields: [{ name: "category" }] },
  ]) {
    assert.throws(() => liveMcpFixture(candidateSource, metadata), /matching live layer metadata/);
  }
});

test("scripted MCP source selection accepts GeoJSON line geometries", () => {
  for (const geometryType of ["LineString", "MultiLineString"]) {
    const source = { ...candidateSource, geometryType };
    assert.equal(selectMcpFixtureSource([source]), source);
  }
});

test("scripted MCP setup skips catalog sources whose layer metadata does not resolve", async () => {
  const unpublished = {
    ...candidateSource,
    id: "reef-watch/3",
    locator: { url: "/rest/services/reef/FeatureServer", layerId: 3 },
  };
  const requested = [];
  const resolved = await resolveMcpFixture([unpublished, candidateSource], async (source) => {
    requested.push(source.id);
    return source === unpublished
      ? { error: { code: 404 } }
      : { id: 0, fields: [{ name: "category", type: "esriFieldTypeString" }] };
  });
  assert.deepEqual(requested, ["reef-watch/3", "synthetic-points/0"]);
  assert.equal(resolved.source, candidateSource);
  assert.equal(resolved.fixture.chartId, "chart-synthetic-points/0-category");
  await assert.rejects(
    resolveMcpFixture([unpublished], async () => ({ error: { code: 404 } })),
    /matching live layer metadata/,
  );
  await assert.rejects(
    resolveMcpFixture([], async () => ({})),
    /published vector FeatureServer/,
  );
});
