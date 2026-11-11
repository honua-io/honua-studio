// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { ShellRouter, type ShellRouterHost } from "../../src/app/shell-router.js";

function host(): ShellRouterHost {
  const target = new EventTarget();
  return {
    routingMode: "hash",
    studioClient: {} as ShellRouterHost["studioClient"],
    auth: {
      mode: "standalone",
      subscribe: (listener: (state: { status: string }) => void) => {
        listener({ status: "signed-out" });
        return () => {};
      },
    } as ShellRouterHost["auth"],
    getAttribute: () => null,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  };
}

function mount(releaseView: () => boolean): { router: ShellRouter; view: HTMLElement } {
  document.body.innerHTML = `<main id="view"></main>`;
  const view = document.querySelector<HTMLElement>("#view")!;
  const router = new ShellRouter({
    host: host(),
    hasView: () => true,
    viewRoot: () => view,
    onRouteRendered: () => {},
    isWorkspaceHost: () => false,
    addCatalogSource: async () => {},
    releaseView,
  });
  return { router, view };
}

function go(hash: string): void {
  window.location.hash = hash;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

describe("ShellRouter route replacement", () => {
  let active: ShellRouter | undefined;

  afterEach(() => {
    active?.stop();
    active = undefined;
    window.location.hash = "";
    document.body.innerHTML = "";
  });

  it("keeps the current view when leaving would discard an open style editor", () => {
    let block = false;
    const { router, view } = mount(() => !block);
    active = router;
    go("#/content");
    router.startHashRouting();
    expect(view.querySelector("[data-testid='content-route']")).toBeTruthy();
    view.insertAdjacentHTML("beforeend", `<p data-testid="editor-sentinel">open</p>`);
    block = true;

    go("#/");

    expect(view.querySelector("[data-testid='editor-sentinel']")).toBeTruthy();
    expect(view.querySelector("[data-testid='content-route']")).toBeTruthy();
    expect(view.querySelector("[data-testid='catalog-section']")).toBeNull();
    expect(router.currentPath).toBe("/content");
    expect(window.location.hash).toBe("#/content");
  });

  it("renders the next route when the current view can be released", () => {
    const { router, view } = mount(() => true);
    active = router;
    go("#/content");
    router.startHashRouting();
    view.insertAdjacentHTML("beforeend", `<p data-testid="editor-sentinel">open</p>`);

    go("#/");

    expect(view.querySelector("[data-testid='editor-sentinel']")).toBeNull();
    expect(view.querySelector("[data-testid='catalog-section']")).toBeTruthy();
    expect(router.currentPath).toBe("/");
  });

  it("keeps a refused host path retryable after the editor is released", () => {
    let dirty = false;
    const { router, view } = mount(() => !dirty);
    active = router;
    expect(router.followHostPath("/content")).toBe(true);
    router.render();
    view.insertAdjacentHTML("beforeend", `<p data-testid="editor-sentinel">open</p>`);
    dirty = true;

    expect(router.followHostPath("/about")).toBe(false);
    router.render();

    expect(router.currentPath).toBe("/content");
    expect(view.querySelector("[data-testid='editor-sentinel']")).toBeTruthy();
    expect(view.querySelector("[data-testid='about-section']")).toBeNull();

    dirty = false;
    expect(router.followHostPath("/about")).toBe(true);
    router.render();
    expect(router.currentPath).toBe("/about");
    expect(view.querySelector("[data-testid='about-section']")).toBeTruthy();
    expect(view.querySelector("[data-testid='editor-sentinel']")).toBeNull();
  });
});
