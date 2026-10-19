import type { IStyleStore, OnStyleChangedCallback, StyleSpecificationWithId } from "../definitions";

/** Ephemeral visual buffer. Only the host can persist an authorized draft. */
export async function createStyleStore(onStyleChanged: OnStyleChangedCallback): Promise<IStyleStore> {
  const parameters = new URLSearchParams(location.hash.slice(1));
  const channel = parameters.get("channel");
  const parentOrigin = parameters.get("parentOrigin");
  if (!channel || !/^[a-f0-9]{64}$/.test(channel) || !parentOrigin || new URL(parentOrigin).origin !== parentOrigin)
    throw new Error("A pinned Honua host channel is required.");
  let latest: StyleSpecificationWithId | undefined;
  const pendingInputs = new Set<Element>();
  let committing: { key: Element; event?: Event } | undefined;
  const inputKey = (element: Element) => element.closest(".cm-editor") ?? element;
  for (const name of ["input", "change", "focusout"])
    document.addEventListener(
      name,
      (event) => {
        if (!(event.target instanceof Element)) return;
        // Native dispatch can run microtasks between capture and React's
        // handler. The exact event remains current only during its dispatch.
        committing = { key: inputKey(event.target), event };
      },
      true,
    );
  let resolveInitial: ((style: StyleSpecificationWithId) => void) | undefined;
  const initial = new Promise<StyleSpecificationWithId>((resolve) => {
    resolveInitial = resolve;
  });
  const send = (data: object) => parent.postMessage({ ...data, channel }, parentOrigin);
  const documentStyle = () => {
    if (!latest) return undefined;
    const { id: _identity, ...style } = latest;
    return style;
  };
  const markPending = (element: Element, event?: Event) => {
    const key = inputKey(element);
    const context = { key, event };
    committing = context;
    // CodeMirror's raw notification and commit share one JS stack. Native
    // inputs use eventPhase to cross browser listener callbacks safely.
    if (!event)
      queueMicrotask(() => {
        if (committing === context) committing = undefined;
      });
    pendingInputs.add(key);
    send({ type: "honua:style-input" });
  };
  window.addEventListener("honua:style-raw-input", ((event: CustomEvent) => {
    if (event.detail?.element instanceof Element) markPending(event.detail.element);
  }) as EventListener);
  document.addEventListener(
    "beforeinput",
    (event) => {
      if (
        event.target instanceof Element &&
        !event.target.closest(".cm-editor") &&
        event.target.closest(".maputnik-layer-editor,.maputnik-code-editor")
      )
        markPending(event.target, event);
    },
    true,
  );
  document.addEventListener(
    "input",
    (event) => {
      if (
        !(event.target instanceof Element) ||
        event.target.closest(".cm-editor") ||
        !event.target.closest(".maputnik-layer-editor,.maputnik-code-editor")
      )
        return;
      markPending(event.target, event);
    },
    true,
  );
  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.origin !== parentOrigin || event.data?.channel !== channel) return;
    if (event.data.type === "honua:style-unlock") {
      document.getElementById("app")?.removeAttribute("inert");
      return;
    }
    if (
      event.data.type === "honua:style-flush" &&
      typeof event.data.requestId === "string" &&
      event.data.requestId.length <= 80
    ) {
      document.getElementById("app")?.setAttribute("inert", "");
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      setTimeout(
        () =>
          send({
            type: "honua:style-flushed",
            requestId: event.data.requestId,
            settled: pendingInputs.size === 0,
            style: documentStyle(),
          }),
        0,
      );
      return;
    }
    if (event.data.type === "honua:style-fields") {
      window.dispatchEvent(new CustomEvent("honua:style-fields", { detail: event.data }));
      return;
    }
    if (event.data.type !== "honua:style-load") return;
    const style = event.data.style;
    if (!style || typeof style !== "object" || style.version !== 8 || JSON.stringify(style).length > 1048576) return;
    latest = { ...style, id: "honua-host-draft" };
    pendingInputs.clear();
    if (resolveInitial) {
      resolveInitial(latest!);
      resolveInitial = undefined;
    } else onStyleChanged(latest!, { save: false, addRevision: false, initialLoad: true });
  });
  send({ type: "honua:style-ready" });
  latest = await initial;
  onStyleChanged(latest, { save: false, initialLoad: true });
  return {
    getLatestStyle: async () => latest!,
    save(style) {
      latest = style;
      // Only a save from this field's actual commit event acknowledges its
      // buffer. Merely focusing a field cannot authorize an unrelated save.
      if (committing && (!committing.event || committing.event.eventPhase !== 0)) pendingInputs.delete(committing.key);
      const snapshot = documentStyle();
      if (JSON.stringify(snapshot).length <= 1048576) send({ type: "honua:style-change", style: snapshot });
      return style;
    },
  };
}
export type { IStyleStore };
