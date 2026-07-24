import { afterEach, describe, expect, it, vi } from "vitest";

import { StudioClient, StudioClientError, StudioSessionExpiredError } from "../../src/client/studio-client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StudioClient auth wiring", () => {
  it("attaches the bearer token to every request when a token source is present", async () => {
    const requests: (string | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        requests.push((init?.headers as Record<string, string> | undefined)?.authorization);
        return jsonResponse(200, { datasets: [] });
      }),
    );
    const auth = { getAccessToken: vi.fn(async () => "access-1") };
    const client = new StudioClient("/api", auth);

    await client.listCatalog();

    expect(requests).toEqual(["Bearer access-1"]);
    expect(auth.getAccessToken).toHaveBeenCalledWith({ forceRefresh: false });
  });

  it("sends no Authorization header when there is no token source", async () => {
    const requests: (string | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        requests.push((init?.headers as Record<string, string> | undefined)?.authorization);
        return jsonResponse(200, { datasets: [] });
      }),
    );
    const client = new StudioClient("/api");

    await client.listCatalog();

    expect(requests).toEqual([undefined]);
  });

  it("on a 401, retries exactly once with a forced refresh, then succeeds", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        return call === 1 ? jsonResponse(401, { error: "unauthorized" }) : jsonResponse(200, { datasets: [] });
      }),
    );
    const getAccessToken = vi.fn(async (options?: { forceRefresh?: boolean }) =>
      options?.forceRefresh ? "access-2" : "access-1",
    );
    const client = new StudioClient("/api", { getAccessToken });

    const datasets = await client.listCatalog();

    expect(datasets).toEqual([]);
    expect(call).toBe(2);
    expect(getAccessToken).toHaveBeenNthCalledWith(1, { forceRefresh: false });
    expect(getAccessToken).toHaveBeenNthCalledWith(2, { forceRefresh: true });
  });

  it("on a second consecutive 401 (refresh didn't help), throws StudioSessionExpiredError — never a third attempt", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        return jsonResponse(401, { error: "unauthorized" });
      }),
    );
    const getAccessToken = vi.fn(async () => "access-1");
    const client = new StudioClient("/api", { getAccessToken });

    await expect(client.listCatalog()).rejects.toBeInstanceOf(StudioSessionExpiredError);
    expect(call).toBe(2); // exactly one retry, never a loop
  });

  it("a 401 with no token source at all still surfaces StudioSessionExpiredError, not a generic error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { error: "unauthorized" })),
    );
    const client = new StudioClient("/api");

    await expect(client.listCatalog()).rejects.toBeInstanceOf(StudioSessionExpiredError);
  });

  it("a non-401, non-OK response is a generic StudioClientError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(500, { error: "boom" })),
    );
    const client = new StudioClient("/api");

    await expect(client.listCatalog()).rejects.toBeInstanceOf(StudioClientError);
    await expect(client.listCatalog()).rejects.not.toBeInstanceOf(StudioSessionExpiredError);
  });

  it("a transport failure is a generic StudioClientError, not a session-expired one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    const client = new StudioClient("/api");

    await expect(client.listCatalog()).rejects.toBeInstanceOf(StudioClientError);
    await expect(client.listCatalog()).rejects.not.toBeInstanceOf(StudioSessionExpiredError);
  });
});
