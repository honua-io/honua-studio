import type {IStyleStore, OnStyleChangedCallback, StyleSpecificationWithId} from "../definitions";

/** Ephemeral visual buffer. Only the host can persist an authorized draft. */
export async function createStyleStore(onStyleChanged: OnStyleChangedCallback): Promise<IStyleStore> {
  const parameters = new URLSearchParams(location.hash.slice(1));
  const channel = parameters.get("channel");
  const parentOrigin = parameters.get("parentOrigin");
  if (!channel || !/^[a-f0-9]{64}$/.test(channel) || !parentOrigin || new URL(parentOrigin).origin !== parentOrigin)
    throw new Error("A pinned Honua host channel is required.");
  let latest: StyleSpecificationWithId | undefined;
  let inputSequence = 0;
  let acceptedSequence = 0;
  let resolveInitial: ((style: StyleSpecificationWithId) => void) | undefined;
  const initial = new Promise<StyleSpecificationWithId>(resolve => { resolveInitial = resolve; });
  const send = (data: object) => parent.postMessage({...data, channel}, parentOrigin);
  const documentStyle = () => {
    if (!latest) return undefined;
    const {id: _identity, ...style} = latest;
    return style;
  };
  document.addEventListener("input", event => {
    if (!(event.target instanceof Element) || !event.target.closest(".maputnik-layer-editor,.maputnik-code-editor")) return;
    inputSequence++;
    send({type: "honua:style-input"});
  }, true);
  window.addEventListener("message", event => {
    if (event.source !== parent || event.origin !== parentOrigin || event.data?.channel !== channel) return;
    if (event.data.type === "honua:style-unlock") {
      document.getElementById("app")?.removeAttribute("inert");
      return;
    }
    if (event.data.type === "honua:style-flush" && typeof event.data.requestId === "string" && event.data.requestId.length <= 80) {
      document.getElementById("app")?.setAttribute("inert", "");
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      setTimeout(() => send({type: "honua:style-flushed", requestId: event.data.requestId,
        settled: inputSequence === acceptedSequence, style: documentStyle()}), 0);
      return;
    }
    if (event.data.type === "honua:style-fields") {
      window.dispatchEvent(new CustomEvent("honua:style-fields", {detail: event.data}));
      return;
    }
    if (event.data.type !== "honua:style-load") return;
    const style = event.data.style;
    if (!style || typeof style !== "object" || style.version !== 8 || JSON.stringify(style).length > 1048576) return;
    latest = {...style, id: "honua-host-draft"};
    acceptedSequence = inputSequence;
    if (resolveInitial) { resolveInitial(latest!); resolveInitial = undefined; }
    else onStyleChanged(latest!, {save: false, addRevision: false, initialLoad: true});
  });
  send({type: "honua:style-ready"});
  latest = await initial;
  onStyleChanged(latest, {save: false, initialLoad: true});
  return {
    getLatestStyle: async () => latest!,
    save(style) {
      latest = style;
      acceptedSequence = inputSequence;
      const document = documentStyle();
      if (JSON.stringify(document).length <= 1048576) send({type: "honua:style-change", style: document});
      return style;
    }
  };
}
export type {IStyleStore};
