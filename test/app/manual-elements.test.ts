// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { CompositionEditor, type CompositionEditorOptions } from "../../src/app/composition-editor.js";
import { ManualElementsHost } from "../../src/app/manual-elements-host.js";
import { ManualElementsPanel } from "../../src/app/manual-elements-panel.js";
import { StalenessEpoch } from "../../src/app/staleness-epoch.js";
import { CompositionController } from "../../src/composition/controller.js";
import { type CompositionState, createEmptyCompositionState } from "../../src/composition/model.js";

function setup(write: (state: CompositionState) => Promise<CompositionState> = async (state) => state) {
  const composition = new CompositionController({
    ...createEmptyCompositionState(),
    layers: [{ id: "parcels", sourceId: "parcel-source", title: "Parcels", visible: true }],
  });
  const authority = { epoch: new StalenessEpoch(), lease: new StalenessEpoch() };
  const drafts = {
    activeMap: new StalenessEpoch(),
    binding: { replace: vi.fn(write) },
    enqueue: <T>(task: () => Promise<T>) => Promise.resolve().then(task),
    announce: vi.fn(),
    markConflict: vi.fn(),
  };
  const editor = new CompositionEditor({
    authority,
    drafts,
    composition,
    hasUnsavedStyleChanges: () => false,
  } as unknown as CompositionEditorOptions);
  const container = document.createElement("section");
  document.body.append(container);
  const panel = new ManualElementsPanel(container, {
    state: () => composition.state,
    dispatch: (commands) => editor.dispatch(commands),
    close: vi.fn(),
  });
  const input = (name: string, value: string) => {
    const element = container.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)!;
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const submit = () => container.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  return { container, panel, input, submit, composition, drafts, editor, authority };
}

afterEach(() => document.body.replaceChildren());

it("persists a source-bound table before exposing it and keeps undo history", async () => {
  let accept!: (state: CompositionState) => void;
  let requested!: CompositionState;
  const { input, submit, composition, drafts, panel } = setup((state) => {
    requested = state;
    return new Promise((resolve) => {
      accept = resolve;
    });
  });
  input("source", "parcels");
  input("title", "Parcel records");
  submit();
  await vi.waitFor(() => expect(drafts.binding.replace).toHaveBeenCalledOnce());
  expect(composition.state.widgets).toHaveLength(0);
  expect(panel.hasPendingChanges).toBe(true);
  expect(requested.widgets[0]).toMatchObject({ kind: "table", sourceId: "parcels", title: "Parcel records" });
  accept(requested);
  await vi.waitFor(() => expect(composition.state.widgets).toHaveLength(1));
  expect(panel.hasPendingChanges).toBe(false);
  expect(composition.canUndo()).toBe(true);
  composition.undo();
  expect(composition.state.widgets).toHaveLength(0);
});

it("shows a rejected server save and preserves entered values", async () => {
  const { input, submit, container, composition, panel } = setup(async () => {
    throw new Error("Refresh this draft before editing.");
  });
  input("source", "parcels");
  submit();
  await vi.waitFor(() =>
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Refresh this draft before editing."),
  );
  expect(composition.state.widgets).toHaveLength(0);
  expect(container.querySelector<HTMLSelectElement>('[name="source"]')?.value).toBe("parcels");
  expect(panel.hasPendingChanges).toBe(true);
});

it("requires a category field and uses it in the persisted chart", async () => {
  const { input, submit, drafts, composition } = setup();
  input("kind", "chart");
  input("source", "parcels");
  input("field", "  ");
  submit();
  expect(drafts.binding.replace).not.toHaveBeenCalled();
  input("field", " zoning_code ");
  submit();
  await vi.waitFor(() =>
    expect(composition.state.widgets[0]).toMatchObject({
      kind: "chart",
      config: { groupBy: "zoning_code", chartType: "bar" },
    }),
  );
});

it("adds and removes a map control through the persistent command path", async () => {
  const { input, submit, composition, container, panel, drafts } = setup();
  input("kind", "scale");
  submit();
  await vi.waitFor(() => expect(composition.state.controls).toHaveLength(1));
  panel.refresh();
  Array.from(container.querySelectorAll("button"))
    .find((button) => button.textContent === "Remove Scale")!
    .click();
  await vi.waitFor(() => expect(composition.state.controls).toHaveLength(0));
  expect(drafts.binding.replace).toHaveBeenCalledTimes(2);
  expect(composition.canUndo()).toBe(true);
});

it("refuses pinned widget removal without contacting the server", async () => {
  const { composition, container, panel, drafts } = setup();
  composition.apply({ name: "addWidget", widget: { id: "legend", kind: "legend", title: "Legend" } });
  composition.apply({ name: "pin", target: { kind: "component", id: "legend" } });
  panel.refresh();
  Array.from(container.querySelectorAll("button"))
    .find((button) => button.textContent === "Remove Legend")!
    .click();
  await vi.waitFor(() => expect(container.querySelector('[role="status"]')?.textContent).toMatch(/pinned/i));
  expect(drafts.binding.replace).not.toHaveBeenCalled();
  expect(composition.state.widgets).toHaveLength(1);
});

it("refreshes available layers without treating layer titles as markup", () => {
  const { composition, panel, container } = setup();
  composition.apply({ name: "addLayer", layer: { id: "new", sourceId: "new-source", title: "<img src=x>" } });
  panel.refresh();
  expect(container.querySelector('option[value="new"]')?.textContent).toBe("<img src=x>");
  expect(container.querySelector("img")).toBeNull();
});
it.each(["session", "draft", "closed"])("refuses queued edits when the %s changes", async (change) => {
  const { panel, container, composition, drafts, editor, authority } = setup();
  panel.dispose();
  container.remove();
  const tasks: (() => Promise<unknown>)[] = [];
  drafts.enqueue = <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve) => {
      tasks.push(async () => resolve(await task()));
    });
  const slots = document.createElement("div");
  document.body.append(slots);
  const chrome = { appSlots: () => slots, markExpanded: vi.fn(), markCollapsed: vi.fn(), focus: vi.fn() };
  const host = new ManualElementsHost({
    authority,
    drafts,
    composition,
    editor,
    chrome,
    isConnected: () => true,
  } as unknown as ConstructorParameters<typeof ManualElementsHost>[0]);
  host.toggle();
  const form = document.querySelector("form")!;
  const kind = form.querySelector<HTMLSelectElement>('[name="kind"]')!;
  kind.value = "legend";
  kind.dispatchEvent(new Event("change", { bubbles: true }));
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  expect(tasks).toHaveLength(1);
  if (change === "session") authority.epoch.next();
  else if (change === "draft") drafts.activeMap.next();
  else host.close();
  await tasks[0]!();
  expect(drafts.binding.replace).not.toHaveBeenCalled();
  expect(composition.state.widgets).toHaveLength(0);
  host.close();
  expect(document.querySelector("#manual-elements-panel")).toBeNull();
});
