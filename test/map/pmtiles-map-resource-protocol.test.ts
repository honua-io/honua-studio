import type { AddProtocolAction } from "maplibre-gl";
import { describe, expect, it, vi } from "vitest";
import {
  createAnonymousPmtilesSource,
  installPmtilesMapResourceProtocol,
} from "../../src/map/pmtiles-map-resource-protocol.js";

const url = "https://archives.example/public.pmtiles";

// One uncompressed z0 tile: exercise the upstream v3 header, directory and metadata parser.
function archive(tileType: number) {
  const metadata = new TextEncoder().encode(JSON.stringify({ vector_layers: [{ id: "land" }] }));
  const root = new Uint8Array([1, 0, 1, 3, 1]);
  const data = new Uint8Array(127 + root.length + metadata.length + 3);
  data.set(new TextEncoder().encode("PMTiles"));
  data[7] = 3;
  const view = new DataView(data.buffer);
  const integer = (offset: number, value: number) => view.setBigUint64(offset, BigInt(value), true);
  integer(8, 127);
  integer(16, root.length);
  integer(24, 127 + root.length);
  integer(32, metadata.length);
  integer(40, 127 + root.length + metadata.length);
  integer(48, 0);
  integer(56, data.length - 3);
  integer(64, 3);
  integer(72, 1);
  integer(80, 1);
  integer(88, 1);
  data[96] = 1;
  data[97] = 1;
  data[98] = 1;
  data[99] = tileType;
  view.setInt32(102, -1800000000, true);
  view.setInt32(106, -850000000, true);
  view.setInt32(110, 1800000000, true);
  view.setInt32(114, 850000000, true);
  data.set(root, 127);
  data.set(metadata, 127 + root.length);
  data.set([7, 8, 9], data.length - 3);
  return data;
}

function transport(data: Uint8Array) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("Range")?.match(/bytes=(\d+)-(\d+)/);
    if (!range) throw new Error("Range required");
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), data.length - 1);
    return new Response(data.slice(start, end + 1), {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/${data.length}`, etag: '"v1"' },
    });
  });
}

function registry() {
  const handlers = new Map<string, AddProtocolAction>();
  return {
    addProtocol: (scheme: string, handler: AddProtocolAction) => handlers.set(scheme, handler),
    removeProtocol: vi.fn((scheme: string) => handlers.delete(scheme)),
    run: (url: string, type?: Parameters<AddProtocolAction>[0]["type"]) => {
      const handler = handlers.get(url.split("://")[0]);
      if (!handler) throw new Error("Missing protocol");
      return handler({ url, type }, new AbortController());
    },
  };
}

describe("anonymous PMTiles", () => {
  it.each([1, 2])("reads archive metadata and z0 bytes for tile type %s", async (tileType) => {
    const network = registry();
    const fetchImpl = transport(archive(tileType));
    const protocol = installPmtilesMapResourceProtocol(network, { fetchImpl });
    const request = protocol.transformRequest(`pmtiles://${url}`);
    const metadata = await network.run(request!.url, "json");
    const tiles = (metadata.data as { tiles: string[] }).tiles;
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatch(/^honua-pmtiles-\d+:\/\//);
    const tile = await network.run(tiles[0].replace("{z}/{x}/{y}", "0/0/0"));
    expect(new Uint8Array(tile.data as ArrayBuffer)).toEqual(new Uint8Array([7, 8, 9]));
    for (const [, init] of fetchImpl.mock.calls)
      expect(init).toMatchObject({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    protocol.dispose();
    expect(network.removeProtocol).toHaveBeenCalledOnce();
    expect(() => protocol.transformRequest(`pmtiles://${url}`)).toThrow("disposed");
  });

  it("treats sparse raster coverage as an empty tile without reporting an error", async () => {
    const network = registry();
    const onError = vi.fn();
    const protocol = installPmtilesMapResourceProtocol(network, { fetchImpl: transport(archive(2)), onError });
    const request = protocol.transformRequest(`pmtiles://${url}/1/1/1.png`)!;
    expect((await network.run(request.url)).data).toBeNull();
    expect(onError).not.toHaveBeenCalled();
    protocol.dispose();
  });

  it.each([
    new Response(new Uint8Array([1]), { status: 200 }),
    new Response(new Uint8Array([1, 2]), { status: 206, headers: { "content-range": "bytes 0-1/2.png" } }),
    new Response(new Uint8Array([1]), { status: 206, headers: { "content-range": "bytes 1-1/2" } }),
    new Response(new Uint8Array([1]), { status: 206, headers: { "content-range": "bytes 0-1/2" } }),
    new Response(new Uint8Array([1, 2]), { status: 206, headers: { "content-range": "bytes 0-0/1" } }),
  ])("rejects a non-range, wrong-range, short or oversized body", async (response) => {
    const source = createAnonymousPmtilesSource(url, new AbortController().signal, {
      fetchImpl: vi.fn(async () => response),
    });
    await expect(source.getBytes(0, 2)).rejects.toThrow();
  });

  it("rejects archive replacement and unsafe ranges before combining data", async () => {
    const fetchImpl = transport(archive(1));
    const source = createAnonymousPmtilesSource(url, new AbortController().signal, { fetchImpl });
    await expect(source.getBytes(0, 16, undefined, '"old"')).rejects.toThrow("changed");
    await expect(source.getBytes(0, 16 * 1024 * 1024 + 1)).rejects.toThrow("size limit");
    await expect(source.getBytes(Number.MAX_SAFE_INTEGER, 10)).rejects.toThrow("size limit");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("refuses credentials, non-HTTP URLs and denied feature endpoints", () => {
    for (const bad of ["https://user:secret@archives.example/a", "file:///archive", "//archives.example/a"])
      expect(() => createAnonymousPmtilesSource(bad, new AbortController().signal)).toThrow();
    expect(() =>
      createAnonymousPmtilesSource(url, new AbortController().signal, { deniedResourceUrls: new Set([url]) }),
    ).toThrow();
  });

  it("aborts in-flight reads on map disposal and isolates registrations", async () => {
    const network = registry();
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
        }),
    );
    const first = installPmtilesMapResourceProtocol(network, { fetchImpl });
    const second = installPmtilesMapResourceProtocol(network);
    const request = first.transformRequest(`pmtiles://${url}`)!;
    expect(second.transformRequest(`pmtiles://${url}`)!.url).not.toBe(request.url);
    const pending = network.run(request.url, "json");
    first.dispose();
    await expect(pending).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
    second.dispose();
  });
});
