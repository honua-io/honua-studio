import { afterEach, expect, it, vi } from "vitest";

import { StudioClient } from "../../src/client/studio-client.js";
import { McpClient } from "../../src/mcp/client.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("reads a server catalog layer identified by serviceLayerIndex", async () => {
  vi.spyOn(McpClient.prototype, "callTool").mockResolvedValue({
    content: [],
    structuredContent: {
      layerCount: 1,
      offset: 0,
      hasMore: false,
      layers: [
        {
          serviceId: "svc-1",
          serviceName: "studio-journey",
          serviceLayerIndex: 2,
          name: "studio-journey-212",
          geometryType: "MultiPolygon",
        },
      ],
    },
  });
  const catalog = await new StudioClient("http://127.0.0.1:18080/api").listCatalog();
  expect(catalog).toEqual([
    {
      id: "svc-1/2",
      title: "studio-journey-212",
      protocol: "geoservices-feature-service",
      geometryType: "MultiPolygon",
      locator: {
        url: "http://127.0.0.1:18080/rest/services/studio-journey/FeatureServer",
        layerId: 2,
        serviceId: "svc-1",
      },
    },
  ]);
});
