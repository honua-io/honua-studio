import { expect, it } from "vitest";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { StudioClient, publishedLayerIndex } from "../../src/client/studio-client.js";

it("reads a server catalog layer identified by serviceLayerIndex", async () => {
  const server = await startMockServer({
    extraDatasets: [
      {
        id: "svc-1",
        title: "studio-journey-212",
        protocol: "geoservices-feature-service",
        geometryType: "MultiPolygon",
        serviceName: "studio-journey",
        serviceLayerIndex: 2,
      },
    ],
  });
  try {
    const catalog = await new StudioClient(`${server.url}/api`, {
      getAccessToken: async () => mintFixtureAccessToken(),
    }).listCatalog();
    expect(catalog.find((entry) => entry.id === "svc-1/2")).toEqual({
      id: "svc-1/2",
      title: "studio-journey-212",
      protocol: "geoservices-feature-service",
      geometryType: "MultiPolygon",
      locator: {
        url: `${server.url}/rest/services/studio-journey/FeatureServer`,
        layerId: 2,
        serviceId: "svc-1",
      },
    });
  } finally {
    await server.close();
  }
});

it("rejects a present layer index that is not a safe non-negative integer", () => {
  expect(publishedLayerIndex({ layerId: -1, serviceLayerIndex: 2 })).toBeUndefined();
  expect(publishedLayerIndex({ layerId: 2, serviceLayerIndex: 3.5 })).toBeUndefined();
  expect(publishedLayerIndex({ layerId: "2", serviceLayerIndex: 2 })).toBeUndefined();
  expect(publishedLayerIndex({ layerId: 2, serviceLayerIndex: 3 })).toBeUndefined();
  expect(publishedLayerIndex({ serviceLayerIndex: 2 })).toBe(2);
  expect(publishedLayerIndex({ layerId: 2, serviceLayerIndex: 2 })).toBe(2);
});
