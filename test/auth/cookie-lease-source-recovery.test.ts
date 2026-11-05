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

it("finishes the feature body the same principal already started when the cookie renews", async () => {
  vi.stubGlobal("location", { origin: "https://studio.test" });
  const auth = session();
  let release!: () => void;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        controller.enqueue(new TextEncoder().encode(JSON.stringify(collection(7))));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const fetch = vi.fn().mockResolvedValueOnce(new Response(stream));
  vi.stubGlobal("fetch", fetch);
  const pending = read(() => auth);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  auth.renewCookie({ ...cookie(), csrfToken: "renewed" });
  release();
  expect(await pending).toEqual(collection(7));
  expect(cancelled).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
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

it("keeps an SDK feature page the same principal already started when the cookie renews", async () => {
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
    queries++;
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            auth.renewCookie({ ...cookie(), csrfToken: "renewed" });
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({
                  ...metadata,
                  spatialReference: { wkid: 4326 },
                  features: [{ attributes: { id: 2 }, geometry: { x: 2, y: 3 } }],
                  exceededTransferLimit: false,
                }),
              ),
            );
            controller.close();
          },
        },
        { highWaterMark: 0 },
      ),
    );
  });
  vi.stubGlobal("fetch", fetch);
  const result = await loadPagedFeatureSource(
    new URL("https://studio.test/rest/services/roads/FeatureServer/1/query?f=geojson"),
    { sourceBaseUrl: "/api", documentUrl: "https://studio.test/studio", getAuth: () => auth },
    new AbortController().signal,
  );
  expect(result.features).toHaveLength(1);
  expect((result.features as { properties: { id: number } }[])[0]!.properties.id).toBe(2);
  expect(queries).toBe(1);
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

it("does not start another feature read when the same principal renews during the body", async () => {
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
  expect(await read(() => auth)).toEqual(collection(999));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(revision).toBe(1);
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
