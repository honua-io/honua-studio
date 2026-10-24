// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExploreDatasetMetadata } from "../../src/recipes/explore-dataset.js";
import { RecipePanel } from "../../src/recipes/recipe-panel.js";

const metadata: ExploreDatasetMetadata = {
  source: {
    id: "actual/0",
    title: "Actual source",
    protocol: "geoservices-feature-service",
    geometryType: "Polygon",
    locator: { url: "/rest/services/actual/FeatureServer", serviceId: "actual", layerId: 0 },
  },
  fields: [{ name: "category", type: "String" }],
  rows: [{ properties: { category: "Real value" } }],
  truncated: false,
};
async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
afterEach(() => {
  document.body.replaceChildren();
});

describe("recipe picker discovery", () => {
  it("aborts stale source metadata and ignores a late response after selecting another source", async () => {
    const outlet = document.createElement("div");
    document.body.append(outlet);
    const requests: { signal: AbortSignal; resolve: (value: ExploreDatasetMetadata) => void }[] = [];
    const describeSource = vi.fn(
      (_id: string, signal: AbortSignal) =>
        new Promise<ExploreDatasetMetadata>((resolve) => requests.push({ signal, resolve })),
    );
    const create = vi.fn();
    const panel = new RecipePanel(outlet, {
      listSources: async () => [metadata.source, { ...metadata.source, id: "second/0" }],
      describeSource,
      create,
      close: vi.fn(),
    });
    await tick();
    const select = outlet.querySelector<HTMLSelectElement>('[name="sourceId"]')!;
    select.value = "actual/0";
    select.dispatchEvent(new Event("change"));
    select.value = "second/0";
    select.dispatchEvent(new Event("change"));
    expect(requests[0].signal.aborted).toBe(true);
    requests[1].resolve({
      ...metadata,
      source: { ...metadata.source, id: "second/0" },
      fields: [{ name: "second", type: "String" }],
      rows: [{ properties: { second: "B" } }],
    });
    await tick();
    requests[0].resolve(metadata);
    await tick();
    expect(outlet.querySelector('[name="categoryField"]')?.textContent).toContain("second");
    expect(outlet.querySelector('[name="categoryField"]')?.textContent).not.toContain("category");
    expect(create).not.toHaveBeenCalled();
    panel.dispose();
  });

  it("shows a read denial without enabling creation and cancels work on close", async () => {
    const outlet = document.createElement("div");
    document.body.append(outlet);
    const create = vi.fn();
    const close = vi.fn();
    let signal!: AbortSignal;
    const panel = new RecipePanel(outlet, {
      listSources: async () => [metadata.source],
      describeSource: async (_id, abort) => {
        signal = abort;
        throw new Error("Permission denied. Request read access.");
      },
      create,
      close,
    });
    await tick();
    const select = outlet.querySelector<HTMLSelectElement>('[name="sourceId"]')!;
    select.value = "actual/0";
    select.dispatchEvent(new Event("change"));
    await tick();
    expect(outlet.querySelector('[role="status"]')?.textContent).toContain("Request read access");
    expect(outlet.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(true);
    outlet.querySelector<HTMLButtonElement>('[data-testid="recipe-close"]')!.click();
    expect(signal.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    panel.dispose();
  });

  it("keeps Close picker keyboard accessible during creation and retains the original retry identity", async () => {
    const outlet = document.createElement("div");
    document.body.append(outlet);
    let fail!: (error: Error) => void;
    const create = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
      )
      .mockResolvedValue({ draftId: "accepted" });
    const close = vi.fn();
    const panel = new RecipePanel(outlet, {
      listSources: async () => [metadata.source],
      describeSource: async () => metadata,
      create,
      close,
    });
    await tick();
    const select = outlet.querySelector<HTMLSelectElement>('[name="sourceId"]')!;
    select.value = "actual/0";
    select.dispatchEvent(new Event("change"));
    await tick();
    outlet.querySelector<HTMLInputElement>('[name="packageKey"]')!.value = "explore";
    outlet.querySelector<HTMLSelectElement>('[name="categoryField"]')!.value = "category";
    outlet.querySelector<HTMLInputElement>('[name="tableFields"]')!.checked = true;
    outlet.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    const closeButton = outlet.querySelector<HTMLButtonElement>('[data-testid="recipe-close"]')!;
    expect(closeButton.disabled).toBe(false);
    expect(closeButton.textContent).toBe("Close picker");
    closeButton.focus();
    closeButton.click();
    expect(close).toHaveBeenCalledOnce();
    fail(new Error("Closed after accepted request"));
    await tick();
    panel.resume();
    expect(document.activeElement).toBe(outlet.querySelector('[data-testid="recipe-create"]'));
    outlet.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await tick();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
    panel.dispose();
  });
});
