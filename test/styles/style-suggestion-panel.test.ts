// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { HostAdapterAuthSession } from "../../src/auth/host-session.js";
import type { CookieSessionAdapter, SessionAdapter } from "../../src/auth/types.js";
import { CompositionController } from "../../src/composition/controller.js";
import { createEmptyCompositionState } from "../../src/composition/model.js";
import type { MapStyleDocument } from "../../src/styles/map-style-edit.js";
import { StyleSuggestionPanel, type StyleSuggestionPanelOptions } from "../../src/styles/style-suggestion-panel.js";
import { STYLE_SUGGESTION_NEEDS_HOST_SESSION } from "../../src/styles/style-suggestion-transport.js";
import type { StyleSuggestionDispatch } from "../../src/styles/style-suggestion.js";

const sessions: HostAdapterAuthSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  document.body.innerHTML = "";
});

function controllerFor() {
  return new CompositionController({
    ...createEmptyCompositionState(),
    layers: [
      { id: "parcels", sourceId: "parcels", type: "fill", title: "Parcels", visible: true },
      { id: "sketch", sourceId: "sketch", type: "circle", title: "Sketch", visible: true },
    ],
    mapSpec: {
      version: 8,
      sources: { parcels: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
      layers: [{ id: "parcels", type: "fill", source: "parcels", paint: { "fill-color": "#112233" } }],
    },
  });
}

const serverSuggestion = {
  success: true,
  data: {
    mapLibreStyle: {
      version: 8,
      layers: [{ id: "12", type: "fill", source: "12", paint: { "fill-color": "#0b7285" } }],
    },
    legend: { title: "Parcels", entries: [{ label: "Parcels", color: "#0b7285" }] },
    paletteName: "Default",
    classificationMethod: "Single",
    observations: ["Geometry follows the server default."],
  },
};

function nativeHost(fetchRequest: typeof fetch) {
  const adapter: CookieSessionAdapter = {
    kind: "cookie",
    baseUrl: "/api/v1/studio",
    principalId: "cookie:operator@example.test",
    environmentId: "demo",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    fetchRequest,
    onExpired: () => () => {},
  };
  const auth = new HostAdapterAuthSession(adapter);
  sessions.push(auth);
  return { session: () => adapter as SessionAdapter, auth: () => auth };
}

function mount(overrides: Partial<StyleSuggestionPanelOptions> = {}) {
  const controller = controllerFor();
  const captured = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(serverSuggestion), { status: 200 }));
  const dispatch = vi.fn<StyleSuggestionDispatch>(async () => ({ ok: true }));
  const onPreview = vi.fn<(style: MapStyleDocument | undefined) => void>();
  const panel = new StyleSuggestionPanel({
    controller,
    catalog: () => [{ id: "parcels", locator: { serviceId: "parcels", layerId: 12 } }],
    host: nativeHost(captured),
    layerId: "parcels",
    dispatch,
    onPreview,
    ...overrides,
  });
  document.body.append(panel.element);
  const q = (id: string) => panel.element.querySelector<HTMLElement>(`[data-testid='${id}']`)!;
  return { controller, captured, dispatch, onPreview, panel, q };
}

describe("style suggestion panel", () => {
  it("previews, then applies the suggestion through the draft dispatch", async () => {
    const { panel, q, captured, dispatch, onPreview } = mount();
    expect(q("style-suggestion-request").hidden).toBe(false);
    expect(q("style-suggestion-apply").closest("div")?.hidden).toBe(true);
    q("style-suggestion-request").click();
    await vi.waitFor(() => expect(panel.previewing).toBe(true));
    expect(captured.mock.calls[0]?.[0]).toBe("api/v1/admin/metadata/layers/12/suggest-style");
    expect(q("style-suggestion-preview").querySelector("[data-style-suggestion-palette]")?.textContent).toBe("Default");
    expect(q("style-suggestion-preview").querySelector("[data-style-suggestion-observations]")?.textContent).toContain(
      "Geometry follows the server default.",
    );
    expect(q("style-suggestion-apply").closest("div")?.hidden).toBe(false);
    const previewed = onPreview.mock.lastCall?.[0] as MapStyleDocument;
    expect((previewed.layers as { paint?: Record<string, unknown> }[])[0]?.paint?.["fill-color"]).toBe("#0b7285");
    q("style-suggestion-apply").click();
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ name: "setLayerStyleRef", target: { id: "parcels" } });
    await vi.waitFor(() =>
      expect(q("style-suggestion-status").textContent).toBe("Applied the suggestion to the map draft."),
    );
    expect(panel.previewing).toBe(false);
    expect(q("style-suggestion-apply").closest("div")?.hidden).toBe(true);
  });

  it("discards a previewed suggestion without writing", async () => {
    const { panel, q, dispatch, onPreview } = mount();
    await panel.request();
    expect(panel.previewing).toBe(true);
    q("style-suggestion-discard").click();
    expect(panel.previewing).toBe(false);
    expect(onPreview).toHaveBeenLastCalledWith(undefined);
    expect(q("style-suggestion-preview").childElementCount).toBe(0);
    expect(q("style-suggestion-status").textContent).toBe("Discarded the suggestion.");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("shows the reason instead of the action for a layer without canonical metadata", async () => {
    const { panel, q, onPreview } = mount();
    await panel.request();
    panel.retarget("sketch");
    expect(onPreview).toHaveBeenLastCalledWith(undefined);
    expect(q("style-suggestion-request").hidden).toBe(true);
    expect(q("style-suggestion-status").textContent).toBe("This source is not an authorized catalog layer.");
    panel.retarget("parcels");
    expect(q("style-suggestion-request").hidden).toBe(false);
    expect(q("style-suggestion-status").textContent).toBe("");
  });

  it("explains that a bearer-only session cannot request suggestions", () => {
    const bearer: SessionAdapter = { getToken: async () => "token", onExpired: () => () => {} };
    const { q } = mount({ host: { session: () => bearer, auth: () => undefined } });
    expect(q("style-suggestion-request").hidden).toBe(true);
    expect(q("style-suggestion-status").textContent).toBe(STYLE_SUGGESTION_NEEDS_HOST_SESSION);
  });

  it("holds requests while the style editor has unsaved edits", async () => {
    let blocked: string | undefined = "Save or discard visual style edits before requesting a style suggestion.";
    const { panel, q, captured } = mount({ blockedReason: () => blocked });
    expect((q("style-suggestion-request") as HTMLButtonElement).disabled).toBe(true);
    expect(q("style-suggestion-status").textContent).toBe(blocked);
    await panel.request();
    expect(captured).not.toHaveBeenCalled();
    blocked = undefined;
    panel.refresh();
    expect((q("style-suggestion-request") as HTMLButtonElement).disabled).toBe(false);
    expect(q("style-suggestion-status").textContent).toBe("");
  });

  it("drops an in-flight request when visual edits start, so its late response never previews", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const captured = vi.fn<typeof fetch>(async (_input, init) => {
      await gate;
      init?.signal?.throwIfAborted();
      return new Response(JSON.stringify(serverSuggestion), { status: 200 });
    });
    const { panel, q, onPreview } = mount({ host: nativeHost(captured) });
    const pending = panel.request();
    await vi.waitFor(() => expect(captured).toHaveBeenCalledOnce());
    panel.discard("Visual style edits replaced the suggestion.");
    release?.();
    await pending;
    expect(onPreview.mock.calls.some(([style]) => style !== undefined)).toBe(false);
    expect(panel.previewing).toBe(false);
    expect(q("style-suggestion-status").textContent).toBe("Visual style edits replaced the suggestion.");
  });

  it("discards a displayed preview once the map changes underneath it", async () => {
    const { panel, q, controller, onPreview } = mount();
    await panel.request();
    expect(panel.previewing).toBe(true);
    controller.apply({ name: "setVisibility", target: { kind: "layer", id: "sketch" }, visible: false });
    panel.refresh();
    expect(panel.previewing).toBe(false);
    expect(onPreview).toHaveBeenLastCalledWith(undefined);
    expect(q("style-suggestion-apply").closest("div")?.hidden).toBe(true);
    expect(q("style-suggestion-status").textContent).toBe("The map changed since the suggestion. Request a new one.");
  });

  it("keeps keyboard focus in the surface after Discard and Apply hide their buttons", async () => {
    const { panel, q } = mount();
    await panel.request();
    q("style-suggestion-discard").focus();
    q("style-suggestion-discard").click();
    expect(document.activeElement).toBe(q("style-suggestion-request"));
    await panel.request();
    q("style-suggestion-apply").focus();
    q("style-suggestion-apply").click();
    await vi.waitFor(() => expect(document.activeElement).toBe(q("style-suggestion-request")));
  });

  it("returns focus to Apply after a refused write, and leaves focus alone once the user moved on", async () => {
    const refused = mount({
      dispatch: vi.fn<StyleSuggestionDispatch>(async () => ({ ok: false, reason: "Conflict." })),
    });
    await refused.panel.request();
    refused.q("style-suggestion-apply").click();
    (document.activeElement as HTMLElement | null)?.blur();
    await vi.waitFor(() => expect(refused.q("style-suggestion-status").textContent).toBe("Conflict."));
    await vi.waitFor(() => expect(document.activeElement).toBe(refused.q("style-suggestion-apply")));
    refused.panel.dispose();

    let release: (() => void) | undefined;
    const slow = mount({
      dispatch: vi.fn<StyleSuggestionDispatch>(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ ok: true });
          }),
      ),
    });
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    await slow.panel.request();
    slow.q("style-suggestion-apply").click();
    elsewhere.focus();
    release?.();
    await vi.waitFor(() =>
      expect(slow.q("style-suggestion-status").textContent).toBe("Applied the suggestion to the map draft."),
    );
    expect(document.activeElement).toBe(elsewhere);
  });

  it("drops a stale preview at once even while a newer request is in flight", async () => {
    const { panel, controller } = mount();
    await panel.request();
    const second = panel.request();
    controller.apply({ name: "setVisibility", target: { kind: "layer", id: "sketch" }, visible: false });
    panel.refresh();
    expect(panel.previewing).toBe(false);
    await second;
    expect(panel.previewing).toBe(false);
  });
});
