import { describe, expect, it, vi } from "vitest";

import { fetchStudioAiCapabilities } from "../../src/chat/capabilities-client.js";
import { ChatTransportError } from "../../src/chat/transport.js";

const CAPABILITIES = { enabled: true, defaultProvider: "claude", providers: [] };

describe("chat/capabilities-client", () => {
  it("unwraps the ApiResponse<T> envelope", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ success: true, data: CAPABILITIES }), { status: 200 }),
    ) as unknown as typeof fetch;
    const result = await fetchStudioAiCapabilities({ baseUrl: "/api", fetchImpl });
    expect(result).toEqual(CAPABILITIES);
  });

  it("accepts an un-enveloped body too", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(CAPABILITIES), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchStudioAiCapabilities({ baseUrl: "/api", fetchImpl });
    expect(result).toEqual(CAPABILITIES);
  });

  it("throws ChatTransportError on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await expect(fetchStudioAiCapabilities({ baseUrl: "/api", fetchImpl })).rejects.toThrow(ChatTransportError);
  });

  it("attaches a bearer token when an auth source is provided", async () => {
    let headers: Headers | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return new Response(JSON.stringify(CAPABILITIES), { status: 200 });
    }) as unknown as typeof fetch;
    const auth = { getAccessToken: vi.fn().mockResolvedValue("tok") };
    await fetchStudioAiCapabilities({ baseUrl: "/api", auth, fetchImpl });
    expect(headers?.get("authorization")).toBe("Bearer tok");
  });
});
