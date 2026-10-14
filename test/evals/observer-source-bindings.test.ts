import { describe, expect, it } from "vitest";
import { bindObservedSources } from "../../scripts/lib/observer-source-bindings.mjs";
const upstream = "http://localhost:19926/honua";
const browser = "http://localhost:5173";
const actual = {
  id: "server/1",
  protocol: "geoservices-feature-service",
  geometryType: "Polygon",
  locator: { serviceId: "server", layerId: 1, url: `${browser}/rest/services/Folder/Parcels/FeatureServer` },
};
const supplied = {
  id: "hi-parcels",
  protocol: actual.protocol,
  geometryType: actual.geometryType,
  serviceId: "server",
  layerId: 1,
  url: `${upstream}/rest/services/Folder/Parcels/FeatureServer/1`,
};
describe("actual browser source discovery bindings", () => {
  it("accepts the established corpus shape and keeps real locator bytes", () => {
    const [bound] = bindObservedSources([supplied], [actual], upstream, browser);
    expect(bound).toEqual({ ...actual, id: supplied.id });
    expect(bound.locator).toBe(actual.locator);
  });
  it("accepts explicit locator identity with the actual deployment prefix", () => {
    expect(
      bindObservedSources(
        [
          {
            id: supplied.id,
            protocol: supplied.protocol,
            geometryType: supplied.geometryType,
            locator: { serviceId: supplied.serviceId, layerId: supplied.layerId, url: supplied.url },
          },
        ],
        [actual],
        upstream,
        browser,
      ),
    ).toHaveLength(1);
  });
  it.each([
    { ...supplied, serviceId: "other" },
    { ...supplied, layerId: 2 },
    { ...supplied, locator: { serviceId: "other", layerId: 1 } },
    { ...supplied, url: "https://foreign.test/rest/services/Folder/Parcels/FeatureServer/1" },
    { ...supplied, url: supplied.url.replace("/honua", "") },
    { ...supplied, url: `${supplied.url}?token=secret` },
    { ...supplied, geometryType: "Point" },
  ])("rejects mismatched or conflicting trusted descriptor %j", (source) => {
    expect(() => bindObservedSources([source], [actual], upstream, browser)).toThrow();
  });
  it("rejects ambiguous discovery and foreign runtime locators", () => {
    expect(() => bindObservedSources([supplied], [actual, actual], upstream, browser)).toThrow();
    expect(() =>
      bindObservedSources(
        [supplied],
        [{ ...actual, locator: { ...actual.locator, url: supplied.url } }],
        upstream,
        browser,
      ),
    ).toThrow();
  });
});

it("binds a legacy published service name only with its exact real locator URL", () => {
  const legacy = { ...supplied, serviceId: "Folder/Parcels" };
  expect(bindObservedSources([legacy], [actual], upstream, browser)[0].locator).toBe(actual.locator);
  expect(() => bindObservedSources([{ ...legacy, url: undefined }], [actual], upstream, browser)).toThrow();
  expect(() =>
    bindObservedSources([{ ...legacy, url: supplied.url.replace("Parcels", "Other") }], [actual], upstream, browser),
  ).toThrow();
  expect(() =>
    bindObservedSources(
      [{ ...legacy, locator: { serviceId: legacy.serviceId, layerId: 1 } }],
      [actual],
      upstream,
      browser,
    ),
  ).toThrow();
});
