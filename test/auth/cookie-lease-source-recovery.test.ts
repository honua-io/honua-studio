import { afterEach, expect, it, vi } from "vitest";
import { HostAdapterAuthSession } from "../../src/auth/host-session.js";
import { fetchAuthenticatedFeatureCollection } from "../../src/map/authenticated-source-protocol.js";
import { loadPagedFeatureSource } from "../../src/map/paged-feature-source.js";

const sessions: HostAdapterAuthSession[] = [];
const cookie = () => ({
  kind: "cookie" as const,
  baseUrl: "/api/studio" as const,
  csrfToken: "initial",
  environmentId: "environment",
  principalId: "owner",
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  onExpired: () => () => {},
});
const collection = (id: number) => ({
  type: "FeatureCollection",
  features: [{ type: "Feature", geometry: null, properties: { id } }],
});
function session() {
  const auth = new HostAdapterAuthSession(cookie());
  sessions.push(auth);
  return auth;
}
function read(getAuth: () => HostAdapterAuthSession | undefined, signal = new AbortController().signal) {
  return fetchAuthenticatedFeatureCollection(
    "https://studio.test/rest/services/roads/FeatureServer/1/query?f=geojson",
    { sourceBaseUrl: "https://studio.test/api", documentUrl: "https://studio.test/studio", getAuth },
    signal,
    "Widget source",
  );
}
afterEach(() => {
  for (const auth of sessions.splice(0)) auth.dispose();
  vi.unstubAllGlobals();
});

it("discards partial old-lease bytes and restarts the bounded feature GET under the renewed lease", async () => {
  vi.stubGlobal("location", { origin: "https://studio.test" });
  const auth = session();
  let release!: () => void;
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('{"type":"FeatureCollection","features":['));
        else {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          controller.enqueue(new TextEncoder().encode('{"properties":{"id":999}}]}'));
          controller.close();
        }
      },
    },
    { highWaterMark: 0 },
  );
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(stream))
    .mockResolvedValueOnce(new Response(JSON.stringify(collection(2))));
  vi.stubGlobal("fetch", fetch);
  const pending = read(() => auth);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  auth.renewCookie({ ...cookie(), csrfToken: "renewed" });
  release();
  expect(await pending).toEqual(collection(2));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
});

it.each([
  { principalId: "other-owner" },
  { environmentId: "other-environment" },
  { sourcePathBase: "/other-deployment" },
])("never restarts under a different current authority %j", async (changed) => {
  vi.stubGlobal("location", { origin: "https://studio.test" });
  const auth = session();
  let current: HostAdapterAuthSession | undefined = auth;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        auth.renewCookie({ ...cookie(), csrfToken: "renewed" });
        current = new HostAdapterAuthSession({ ...cookie(), ...changed });
        sessions.push(current);
        controller.enqueue(new TextEncoder().encode(JSON.stringify(collection(999))));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const fetch = vi.fn().mockResolvedValue(new Response(stream));
  vi.stubGlobal("fetch", fetch);
  await expect(read(() => current)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("restarts an SDK feature page after body renewal without reusing the rejected page", async () => {
  vi.stubGlobal("location", { origin: "https://studio.test" });
  const auth = session();
  const metadata = {
    id: 1,
    geometryType: "esriGeometryPoint",
    objectIdField: "id",
    fields: [{ name: "id", type: "esriFieldTypeOID" }],
  };
  let queries = 0;
  const fetch = vi.fn().mockImplementation(async (input) => {
    if (!String(input).includes("/query")) return Response.json(metadata);
    if (++queries === 1)
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              auth.renewCookie({ ...cookie(), csrfToken: "renewed" });
              controller.enqueue(new TextEncoder().encode("rejected-old-page"));
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
      );
    return Response.json({
      ...metadata,
      spatialReference: { wkid: 4326 },
      features: [{ attributes: { id: 2 }, geometry: { x: 2, y: 3 } }],
      exceededTransferLimit: false,
    });
  });
  vi.stubGlobal("fetch", fetch);
  const result = await loadPagedFeatureSource(
    new URL("https://studio.test/rest/services/roads/FeatureServer/1/query?f=geojson"),
    { sourceBaseUrl: "/api", documentUrl: "https://studio.test/studio", getAuth: () => auth },
    new AbortController().signal,
  );
  expect(result.features).toHaveLength(1);
  expect((result.features as { properties: { id: number } }[])[0]!.properties.id).toBe(2);
  expect(queries).toBe(2);
});

it("does not restart an aborted feature read", async () => {
  vi.stubGlobal("location", { origin: "https://studio.test" });
  const auth = session();
  const abort = new AbortController();
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        auth.renewCookie({ ...cookie(), csrfToken: "renewed" });
        abort.abort();
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const fetch = vi.fn().mockResolvedValue(new Response(stream));
  vi.stubGlobal("fetch", fetch);
  await expect(read(() => auth, abort.signal)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("bounds renewal recovery to one restart even if the second body also renews", async () => {
  vi.stubGlobal("location", { origin: "https://studio.test" });
  const auth = session();
  let revision = 0;
  const fetch = vi.fn().mockImplementation(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              auth.renewCookie({ ...cookie(), csrfToken: `renewed-${++revision}` });
              controller.enqueue(new TextEncoder().encode(JSON.stringify(collection(999))));
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(read(() => auth)).rejects.toThrow(/session.*renew/i);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("rejects a disposed cookie authority's body and refuses later requests or renewal", async () => {
  vi.stubGlobal("location", { origin: "https://studio.test" });
  const auth = session();
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(collection(999))));
  vi.stubGlobal("fetch", fetch);
  const response = await auth.fetchRequest!("/rest/services/roads/FeatureServer/1/query?f=geojson");
  auth.dispose();
  await expect(response.text()).rejects.toThrow(/expired/);
  await expect(auth.fetchRequest!("/api/v1/studio/catalog")).rejects.toThrow(/expired/);
  expect(() => auth.renewCookie(cookie())).toThrow(/disposed/);
  expect(fetch).toHaveBeenCalledTimes(1);
});
