// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioAppElement } from "../../src/elements/studio-app-element.js";
import type { HonuaStudioCanvasElement } from "../../src/elements/studio-canvas-element.js";
import { StudioLifecycleClient } from "../../src/lifecycle/lifecycle-client.js";
import { toCompositionDraftBody } from "../../src/mcp/composition-envelope.js";
import { AuthoritativeStyleProvider } from "../../src/styles/authoritative-style-provider.js";
import { designFixture } from "./design-fixture.js";

registerAllStudioElements();

async function mount(): Promise<HonuaStudioAppElement> {
  const app = document.createElement("honua-studio-app") as HonuaStudioAppElement;
  app.session = { getToken: async () => "fixture", onExpired: () => () => {} };
  app.agentSessionAdapter = {
    submitTurn: async () => {
      throw new Error("not used");
    },
  };
  app.sourceCatalog = [
    {
      id: "source-a",
      title: "private source",
      protocol: "geoservices-feature-service",
      geometryType: "Point",
      locator: { serviceId: "svc", layerId: 0, url: "/api/rest/services/svc/FeatureServer/0" },
    },
  ];
  document.body.append(app);
  await app.auth.getAccessToken();
  app.composition.resetBaseline(designFixture());
  await app.openDesignInspector();
  return app;
}

beforeEach(() =>
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("No network in unit test"))),
  ),
);
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("embedded design inspector", () => {
  it("loads actual authorized fields, reports missing fields, and selects relationship owners through the existing event", async () => {
    const describe = vi.spyOn(AuthoritativeStyleProvider.prototype, "describeSource").mockResolvedValue([
      { name: "category", type: "string" },
      { name: "name", type: "string" },
    ]);
    const app = await mount();
    await vi.waitFor(() => expect(app.shadowRoot?.textContent).toContain("Unavailable fields: missing, id"));
    expect(describe).toHaveBeenCalledTimes(1);
    const listener = vi.fn();
    app.addEventListener("honua-studio-selection-change", listener);
    const button = app.shadowRoot?.querySelector<HTMLButtonElement>(
      '[data-relationship="hide"][data-ref="layer:places"]',
    );
    button?.click();
    expect(app.composition.selection).toEqual([{ kind: "layer", id: "places" }]);
    expect(app.selectedDesignRelationship).toEqual({ interactionId: "hide", ownerRef: "layer:places" });
    expect(listener.mock.calls[0]?.[0].detail).toEqual({
      targets: [{ kind: "layer", id: "places" }],
      relationship: { interactionId: "hide", ownerRef: "layer:places" },
    });
    app.composition.apply({ name: "setVisibility", target: { kind: "layer", id: "places" }, visible: false });
    expect(app.selectedDesignRelationship).toBeUndefined();
    expect(
      app.shadowRoot?.querySelector('[data-testid="design-inspector-toggle"]')?.getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("keeps denied descriptions explicit and preserves the accepted draft", async () => {
    vi.spyOn(AuthoritativeStyleProvider.prototype, "describeSource").mockRejectedValue(
      new Error("Source access denied. Refresh authorization."),
    );
    const app = await mount();
    const state = app.composition.state;
    await vi.waitFor(() => expect(app.shadowRoot?.textContent).toContain("Source access denied"));
    expect(app.composition.state).toBe(state);
    expect(app.shadowRoot?.textContent).toContain("Fields unavailable");
  });

  it("retains the inspector through unchanged polling and same-principal renewal, while invalidating revised relationship focus", async () => {
    vi.spyOn(AuthoritativeStyleProvider.prototype, "describeSource").mockResolvedValue([]);
    const app = await mount();
    const lease = {
      kind: "cookie" as const,
      baseUrl: "/api/studio",
      sourcePathBase: "/api",
      environmentId: "environment",
      principalId: "principal",
      csrfToken: "csrf-1",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      onExpired: () => () => {},
    };
    app.session = lease;
    let revision = 1;
    vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockImplementation(
      async () =>
        ({
          draftId: "same",
          generation: revision,
          packageKey: "same",
          envelope: {
            family: "map",
            schemaVersion: "1.0",
            format: "honua_map_package.v1",
            body: toCompositionDraftBody(designFixture(), "same"),
          },
        }) as Awaited<ReturnType<StudioLifecycleClient["getDraft"]>>,
    );
    await app.attachWorkspaceDraft("same");
    await app.openDesignInspector();
    const panel = app.shadowRoot!.querySelector("#design-inspector-panel");
    app.shadowRoot!.querySelector<HTMLButtonElement>('[data-relationship="hide"][data-ref="layer:places"]')!.click();
    for (let poll = 0; poll < 2; poll++) {
      expect(await app.refreshWorkspaceDraft()).toBe(true);
      expect(app.shadowRoot!.querySelector("#design-inspector-panel")).toBe(panel);
      expect(app.selectedDesignRelationship).toEqual({ interactionId: "hide", ownerRef: "layer:places" });
    }
    app.session = { ...lease, csrfToken: "csrf-2", expiresAt: new Date(Date.now() + 7200000).toISOString() };
    expect(app.shadowRoot!.querySelector("#design-inspector-panel")).toBe(panel);
    expect(app.selectedDesignRelationship).toEqual({ interactionId: "hide", ownerRef: "layer:places" });
    revision = 2;
    expect(await app.refreshWorkspaceDraft()).toBe(true);
    expect(app.shadowRoot!.querySelector("#design-inspector-panel")).not.toBeNull();
    expect(app.selectedDesignRelationship).toBeUndefined();
    app.session = { ...lease, principalId: "another" };
    expect(app.shadowRoot!.querySelector("#design-inspector-panel")).toBeNull();
  });

  it("does not route a colliding intrinsic ID into authored relationship context and retains exact keyboard focus", async () => {
    vi.spyOn(AuthoritativeStyleProvider.prototype, "describeSource").mockResolvedValue([
      { name: "category", type: "string" },
    ]);
    const app = await mount();
    const state = app.composition.state;
    app.composition.resetBaseline({
      ...state,
      interactions: [{ ...state.interactions[0]!, id: "intrinsic:filter:layer:places" }],
    });
    await vi.waitFor(() =>
      expect(
        app.shadowRoot?.querySelector(
          '[data-connection-origin="intrinsic"][data-connection="intrinsic:filter:layer:places"] button[data-ref="layer:places"]',
        ),
      ).not.toBeNull(),
    );
    const intrinsic = app.shadowRoot!.querySelector<HTMLButtonElement>(
      '[data-connection-origin="intrinsic"][data-connection="intrinsic:filter:layer:places"] button[data-ref="layer:places"]',
    )!;
    const id = intrinsic.id;
    intrinsic.focus();
    intrinsic.click();
    await Promise.resolve();
    expect(app.selectedDesignRelationship).toBeUndefined();
    expect(app.shadowRoot!.activeElement?.id).toBe(id);
    const authored = app.shadowRoot!.querySelector<HTMLButtonElement>(
      '[data-connection-origin="authored"][data-connection="intrinsic:filter:layer:places"] button[data-ref="layer:places"]',
    )!;
    expect(authored.id).not.toBe(id);
    authored.click();
    expect(app.selectedDesignRelationship).toEqual({
      interactionId: "intrinsic:filter:layer:places",
      ownerRef: "layer:places",
    });
  });

  it("preserves same-draft private context and accepted edits after failed switches, then clears it on an accepted new draft", async () => {
    vi.spyOn(AuthoritativeStyleProvider.prototype, "describeSource").mockResolvedValue([]);
    const app = await mount();
    const get = vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockImplementation(async (id) => {
      if (id === "denied") throw new Error("Denied draft");
      return {
        draftId: id,
        generation: 1,
        packageKey: id,
        envelope: {
          family: "map",
          schemaVersion: "1.0",
          format: "honua_map_package.v1",
          body: {
            layers: [{ id: "places", sourceId: "source-a", visible: true }],
            controls: [
              {
                id: "filter",
                kind: "filterSelect",
                sourceId: "source-a",
                config: { field: "category", options: ["A"] },
              },
            ],
          },
        },
      } as Awaited<ReturnType<StudioLifecycleClient["getDraft"]>>;
    });
    await app.attachWorkspaceDraft("first");
    app.composition.apply({
      name: "addAnnotation",
      annotation: { id: "private", kind: "note", text: "Private prior draft" },
    });
    app.composition.apply({ name: "pin", target: { kind: "layer", id: "places" } });
    app.composition.select([{ kind: "layer", id: "places" }]);
    const canvas = app.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas")!;
    await vi.waitFor(() => expect(canvas.interactions).toBeDefined());
    canvas.interactions!.publishControlChange("filter", { field: "category", operator: "=", value: "A" });
    await app.attachWorkspaceDraft("first");
    expect(app.composition.state.annotations[0]?.text).toBe("Private prior draft");
    expect(app.composition.state.pins).toHaveLength(1);
    expect(canvas.interactions!.temporaryFilterSummary()).toHaveLength(1);
    const accepted = app.composition.state;
    await expect(app.attachWorkspaceDraft("denied")).rejects.toThrow("Denied draft");
    expect(app.composition.state).toBe(accepted);
    expect(canvas.interactions!.temporaryFilterSummary()).toHaveLength(1);
    await app.attachWorkspaceDraft("second");
    await vi.waitFor(() => expect(canvas.interactions).toBeDefined());
    expect(app.composition.state.annotations).toEqual([]);
    expect(app.composition.state.pins).toEqual([]);
    expect(app.composition.selection).toEqual([]);
    expect(canvas.interactions!.temporaryFilterSummary()).toEqual([]);
    expect(get).toHaveBeenCalledTimes(4);
  });

  it("aborts metadata and removes previous private context when the authority changes", async () => {
    let resolve: ((fields: readonly { name: string; type: string }[]) => void) | undefined;
    let signal: AbortSignal | undefined;
    vi.spyOn(AuthoritativeStyleProvider.prototype, "describeSource").mockImplementation(function (
      this: AuthoritativeStyleProvider,
    ) {
      // Provider is the real authentication boundary; inspect its supplied cancellation signal.
      signal = (this as unknown as { options: { signal: AbortSignal } }).options.signal;
      return new Promise((done) => {
        resolve = done;
      });
    });
    const app = await mount();
    expect(signal?.aborted).toBe(false);
    app.session = { getToken: async () => "different caller", onExpired: () => () => {} };
    expect(signal?.aborted).toBe(true);
    resolve?.([{ name: "previous_private_field", type: "string" }]);
    await Promise.resolve();
    expect(app.shadowRoot?.querySelector('[data-testid="design-inspector"]')).toBeNull();
    expect(app.shadowRoot?.textContent).not.toContain("previous_private_field");
    expect(app.composition.state.layers).toEqual([]);
  });

  it("closes and cancels metadata as soon as a draft switch starts, including a refused read", async () => {
    let signal: AbortSignal | undefined;
    vi.spyOn(AuthoritativeStyleProvider.prototype, "describeSource").mockImplementation(function (
      this: AuthoritativeStyleProvider,
    ) {
      signal = (this as unknown as { options: { signal: AbortSignal } }).options.signal;
      return Promise.resolve([{ name: "category", type: "string" }]);
    });
    const app = await mount();
    const pending = app.attachWorkspaceDraft("denied-draft");
    expect(app.shadowRoot?.querySelector('[data-testid="design-inspector"]')).toBeNull();
    await expect(pending).rejects.toThrow();
    expect(app.composition.state.layers).toHaveLength(2);
    expect(signal).toBeDefined();
  });
});
