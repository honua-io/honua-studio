// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const attachedAgentOptions = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@honua/sdk-js/studio-agent", async (importOriginal) => {
  const original = await importOriginal<typeof import("@honua/sdk-js/studio-agent")>();
  return {
    ...original,
    createStudioAgentSession: (options: Record<string, unknown>) => {
      attachedAgentOptions.push(options);
      return original.createStudioAgentSession(
        options as unknown as Parameters<typeof original.createStudioAgentSession>[0],
      );
    },
  };
});

import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioAppElement } from "../../src/elements/studio-app-element.js";
import type { HonuaStudioChatElement } from "../../src/elements/studio-chat-element.js";
import type { HonuaStudioCompositionModeChangeDetail } from "../../src/elements/types.js";

registerAllStudioElements();

/**
 * Same discipline as `studio-app-element.test.ts`: assign a `SessionAdapter`
 * BEFORE `appendChild` so the element is in host-adapter auth mode (no OIDC
 * discovery fetch to race), and disable the network so the catalog fetch this
 * shell now makes on connect (honua-studio#23) fails fast and silently.
 * Nothing in this file is about either.
 */
function mount(): HonuaStudioAppElement {
  const element = document.createElement("honua-studio-app") as HonuaStudioAppElement;
  element.session = { getToken: async () => "fixture-token", onExpired: () => () => {} };
  document.body.appendChild(element);
  return element;
}

function control<T extends Element>(element: HonuaStudioAppElement, testId: string): T {
  const found = element.shadowRoot?.querySelector<T>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`missing control: ${testId}`);
  return found;
}

function enableDraftFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } }),
          { headers: { "content-type": "application/json", "mcp-session-id": "session-1" } },
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            structuredContent: {
              draftId: "draft-current",
              packageKey: "pkg-live",
              generation: 1,
              envelope: { family: "map", schemaVersion: "1", body: { layers: [], view: {}, widgets: [] } },
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }),
  );
}

async function goLive(element: HonuaStudioAppElement, packageKey: string, family?: string): Promise<void> {
  control<HTMLButtonElement>(element, "live-composition-toggle").click();
  control<HTMLInputElement>(element, "live-composition-package-key").value = packageKey;
  if (family) control<HTMLSelectElement>(element, "live-composition-family").value = family;
  control<HTMLFormElement>(element, "live-composition-form").dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
}

beforeEach(() => {
  attachedAgentOptions.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("network disabled in unit tests"))),
  );
});

afterEach(async () => {
  // `HostAdapterAuthSession` resolves the host token in a fire-and-forget
  // microtask and re-renders on the result. Most tests here are synchronous,
  // so that resolution would otherwise land *after* the DOM was torn down and
  // repaint a detached shadow root — which happy-dom reports as an unhandled
  // rejection rather than a test failure. Let it settle first.
  await new Promise((resolve) => setTimeout(resolve, 0));
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("<honua-studio-app> live-composition affordance (honua-studio#23 REQ-004)", () => {
  it("boots in fixture mode with the control collapsed — fixture is the default (REQ-005)", () => {
    const element = mount();
    expect(control(element, "live-composition-status").textContent).toBe("Fixture mode");
    expect(control<HTMLFormElement>(element, "live-composition-form").hidden).toBe(true);
    expect(control(element, "live-composition-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(element.toolCallOrchestrator.isLive).toBe(false);
  });

  it("opens the connect form from the header button", () => {
    const element = mount();
    control<HTMLButtonElement>(element, "live-composition-toggle").click();
    expect(control<HTMLFormElement>(element, "live-composition-form").hidden).toBe(false);
    expect(control(element, "live-composition-toggle").getAttribute("aria-expanded")).toBe("true");
  });

  it("attaches a live session from the UI — no window.__honuaStudioApp required", async () => {
    const element = mount();
    await goLive(element, "pkg-live-1", "app");

    expect(element.toolCallOrchestrator.isLive).toBe(true);
    expect(control(element, "live-composition-status").textContent).toContain("pkg-live-1");
    expect(control(element, "live-composition-status").getAttribute("data-mode")).toBe("live");
    expect(control(element, "live-composition-toggle").textContent).toBe("Return to fixture");
    expect(control<HTMLFormElement>(element, "live-composition-form").hidden).toBe(true);
  });

  it("refuses to connect without a package key rather than attaching a nameless session", async () => {
    const element = mount();
    await goLive(element, "   ");
    expect(element.toolCallOrchestrator.isLive).toBe(false);
    expect(control(element, "live-composition-status").textContent).toBe("Fixture mode");
  });

  it("returns to fixture mode from the same button", async () => {
    const element = mount();
    await goLive(element, "pkg-live-1");
    control<HTMLButtonElement>(element, "live-composition-toggle").click();

    expect(element.toolCallOrchestrator.isLive).toBe(false);
    expect(control(element, "live-composition-status").textContent).toBe("Fixture mode");
    expect(control(element, "live-composition-toggle").textContent).toBe("Go live…");
  });

  it("announces every mode change so an embedding host can mirror it", async () => {
    const element = mount();
    const changes: HonuaStudioCompositionModeChangeDetail[] = [];
    element.addEventListener("honua-studio-composition-mode-change", (event) => {
      changes.push((event as CustomEvent<HonuaStudioCompositionModeChangeDetail>).detail);
    });

    await goLive(element, "pkg-live-1", "map");
    element.disableLiveComposition();

    expect(changes).toEqual([{ mode: "live", packageKey: "pkg-live-1", family: "map" }, { mode: "fixture" }]);
  });

  it("records the switch in the shared activity log, like any other consequential action", async () => {
    const element = mount();
    await goLive(element, "pkg-live-1", "map");
    const chat = element.querySelector<HonuaStudioChatElement>("honua-studio-chat");
    const entries = chat?.activityLog.entries().filter((entry) => entry.type === "composition_mode_changed") ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.detail).toMatchObject({ mode: "live", packageKey: "pkg-live-1" });
  });

  it("keeps the programmatic API working — the test hook path #7 established still applies", () => {
    const element = mount();
    element.enableLiveComposition({ packageKey: "pkg-programmatic", family: "map" });
    expect(element.toolCallOrchestrator.isLive).toBe(true);
    expect(control(element, "live-composition-status").textContent).toContain("pkg-programmatic");
  });

  it("offers only composition-eligible package families", () => {
    const element = mount();
    const options = [...control<HTMLSelectElement>(element, "live-composition-family").options].map(
      (option) => option.value,
    );
    expect(options).toEqual(["map", "app"]);
  });
});

describe("<honua-studio-app> map wiring (honua-studio#23)", () => {
  it("keeps durable mutations out of the local runtime plane so SDK discovery owns them", () => {
    const element = document.createElement("honua-studio-app") as HonuaStudioAppElement;
    const names = element.agentToolDefinitions(element.aiMapKit).map((tool) => tool.name);
    expect(names).toContain("inspectMap");
    expect(names).toContain("selectFeature");
    expect(names).not.toContain("honua_studio_add_layer");
    expect(names).not.toContain("honua_studio_set_view");
    expect(names).not.toContain("honua_studio_set_layer_visibility");
    expect(names).not.toContain("addLayer");
    expect(names).not.toContain("setViewport");
    expect(names.some((name) => name.startsWith("honua_studio_"))).toBe(false);
  });

  it("retains a replaceable discovery-provider seam around today's static schemas", () => {
    const element = document.createElement("honua-studio-app") as HonuaStudioAppElement;
    element.agentToolDefinitions = () => [
      {
        name: "discoveredProbe",
        description: "Test replacement for the static schema provider.",
        mode: "read",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ];
    expect(element.agentToolDefinitions(element.aiMapKit).map((tool) => tool.name)).toEqual(["discoveredProbe"]);
  });

  it("keeps pre-connect tool-schema configuration side-effect free so orchestration shares the chat log", async () => {
    const element = document.createElement("honua-studio-app") as HonuaStudioAppElement;
    element.agentToolDefinitions = () => [];
    element.session = { getToken: async () => "fixture-token", onExpired: () => () => {} };
    document.body.appendChild(element);

    await element.toolCallOrchestrator.handleToolCall({
      toolName: "addLayer",
      arguments: { layer: { id: "roads", sourceId: "roads-source" } },
    });

    const chat = element.querySelector<HonuaStudioChatElement>("honua-studio-chat");
    expect(chat?.activityLog.entries().some((entry) => entry.type === "composition_command_applied")).toBe(true);
  });

  it("rebuilds both live clients with replacement host credentials even when the host owns the catalog", async () => {
    enableDraftFetch();
    const element = mount();
    element.sourceCatalog = [];
    element.enableLiveComposition({ packageKey: "pkg-live-auth" });
    await vi.waitFor(() => expect(attachedAgentOptions).toHaveLength(1));
    const firstSession = element.querySelector<HonuaStudioChatElement>("honua-studio-chat")?.agentSession;

    element.session = { getToken: async () => "replacement-token", onExpired: () => () => {} };

    await vi.waitFor(() => expect(attachedAgentOptions).toHaveLength(2));
    const secondSession = element.querySelector<HonuaStudioChatElement>("honua-studio-chat")?.agentSession;
    expect(secondSession).not.toBe(firstSession);
    const replacementAuth = attachedAgentOptions[1]?.auth as { getAccessToken: () => Promise<string | undefined> };
    await expect(replacementAuth.getAccessToken()).resolves.toBe("replacement-token");
  });

  it("ignores draft events emitted by a superseded agent session", async () => {
    enableDraftFetch();
    const element = mount();
    element.sourceCatalog = [];
    element.enableLiveComposition({ packageKey: "pkg-live-stale" });
    await vi.waitFor(() => expect(attachedAgentOptions).toHaveLength(1));
    const staleOnEvent = attachedAgentOptions[0]?.onEvent as (event: unknown) => void;

    element.agentToolDefinitions = () => [];
    await vi.waitFor(() => expect(attachedAgentOptions).toHaveLength(2));
    staleOnEvent({
      type: "toolResult",
      result: {
        draft: {
          draftId: "stale-draft",
          packageKey: "pkg-live-stale",
          generation: 99,
          envelope: { family: "map", schemaVersion: "1", body: { layers: [], view: {}, widgets: [] } },
        },
      },
    });

    expect(element.toolCallOrchestrator.draftId).not.toBe("stale-draft");
    expect(element.toolCallOrchestrator.generation).not.toBe(99);
  });

  it("hands an assigned catalog straight to the auto-composed canvas", () => {
    const element = mount();
    element.sourceCatalog = [{ id: "hi-parcels", title: "Parcels", protocol: "ogc-features", geometryType: "Polygon" }];
    const canvas = element.querySelector("honua-studio-canvas") as { sourceCatalog?: readonly { id: string }[] };
    expect(canvas.sourceCatalog?.map((entry) => entry.id)).toEqual(["hi-parcels"]);
  });

  it("builds an SDK AI map kit over the same composition controller", async () => {
    const element = mount();
    element.sourceCatalog = [{ id: "hi-parcels", title: "Parcels", protocol: "ogc-features", geometryType: "Polygon" }];
    const kit = element.aiMapKit;
    expect(kit.tools.map((tool) => tool.name)).toContain("addLayer");

    await kit.execute({ name: "setViewport", args: { zoom: 6 } });
    expect(element.composition.state.view.zoom).toBe(6);
  });
});
