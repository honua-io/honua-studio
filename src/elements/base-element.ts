/**
 * Shared custom-element base for every Honua Studio surface element
 * (honua-studio#5 REQ-001). Mirrors the cleanup/focus discipline
 * honua-sdk-js's `src/web-components/elements.ts` (`HonuaElementBase`)
 * already established, scaled down to what Studio's placeholder + shell
 * elements need:
 *
 *  - a single `AbortController` per connection, so every listener/subscription
 *    registered through {@link HonuaStudioElementBase.listen} or
 *    {@link HonuaStudioElementBase.connectedSignal} is guaranteed removed on
 *    `disconnectedCallback` — the "no leaked listeners/observers" invariant
 *    the issue calls out explicitly, and what test/elements/cleanup.test.ts
 *    verifies;
 *  - an open shadow root per element (real encapsulation — the whole point
 *    of an embeddable contract is that a host's global CSS/JS can't reach
 *    in), with a focus-preserving `innerHTML` setter so a host's unrelated
 *    DOM patch elsewhere on the page (the Blazor SSR-patch hazard) can never
 *    steal focus from a control inside;
 *  - a single typed-`CustomEvent` dispatch helper (`bubbles: true, composed:
 *    true` — events must cross the shadow boundary to reach a host listener).
 */

export interface FocusSnapshot {
  readonly selector: string;
  readonly value?: string;
  readonly selectionStart?: number;
  readonly selectionEnd?: number;
  readonly selectionDirection?: "forward" | "backward" | "none";
}

type TextControl = HTMLInputElement | HTMLTextAreaElement;

function isTextControl(element: Element): element is TextControl {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

function cssAttributeValue(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

function focusSelector(element: Element): string | undefined {
  const tagName = element.localName;
  for (const name of ["id", "name"]) {
    const value = element.getAttribute(name);
    if (value) return `${tagName}[${name}="${cssAttributeValue(value)}"]`;
  }
  for (const name of element.getAttributeNames().filter((attribute) => attribute.startsWith("data-"))) {
    const value = element.getAttribute(name);
    if (value) return `${tagName}[${name}="${cssAttributeValue(value)}"]`;
  }
  return undefined;
}

/** Captures enough of the current focus (element + text selection) inside `root` to restore it after an `innerHTML` replace. */
export function captureFocus(root: ShadowRoot): FocusSnapshot | undefined {
  const active = root.activeElement;
  if (!active) return undefined;
  const selector = focusSelector(active);
  if (!selector) return undefined;
  const control = isTextControl(active) ? active : undefined;
  return {
    selector,
    ...(control ? { value: control.value } : {}),
    ...(typeof control?.selectionStart === "number" ? { selectionStart: control.selectionStart } : {}),
    ...(typeof control?.selectionEnd === "number" ? { selectionEnd: control.selectionEnd } : {}),
    ...(control?.selectionDirection
      ? { selectionDirection: control.selectionDirection as "forward" | "backward" | "none" }
      : {}),
  };
}

/** Restores a {@link captureFocus} snapshot after an `innerHTML` replace, including text selection when the same value is still present. */
export function restoreFocus(root: ShadowRoot, snapshot: FocusSnapshot | undefined): void {
  if (!snapshot) return;
  const target = root.querySelector(snapshot.selector);
  if (!target || !(target instanceof HTMLElement) || typeof target.focus !== "function") return;
  target.focus({ preventScroll: true });
  if (
    snapshot.value === undefined ||
    snapshot.selectionStart === undefined ||
    snapshot.selectionEnd === undefined ||
    !isTextControl(target) ||
    target.value !== snapshot.value
  ) {
    return;
  }
  target.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd, snapshot.selectionDirection ?? "none");
}

/**
 * Base class every `honua-studio-*` element extends. Subclasses implement
 * {@link render} and may override {@link onConnect}/{@link onDisconnect} for
 * work beyond what the base class's own listener bookkeeping covers.
 */
export abstract class HonuaStudioElementBase extends HTMLElement {
  #abort: AbortController | undefined;
  #connectedOnce = false;

  /** The signal for the current connection. `undefined` while disconnected — use it to guard async work started in `onConnect`. */
  protected get connectedSignal(): AbortSignal | undefined {
    return this.#abort?.signal;
  }

  public connectedCallback(): void {
    this.#abort = new AbortController();
    this.ensureShadowRoot();
    this.onConnect(this.#abort.signal);
    this.render();
    if (!this.#connectedOnce) {
      this.#connectedOnce = true;
      this.dispatchTypedEvent("honua-studio-ready", { tagName: this.localName });
    }
  }

  public disconnectedCallback(): void {
    this.#abort?.abort();
    this.#abort = undefined;
    this.onDisconnect();
  }

  /** Hook for subclasses: attach listeners/observers/subscriptions here, tied to `signal` (or {@link connectedSignal}). Called before the first {@link render}. */
  protected onConnect(_signal: AbortSignal): void {}

  /** Hook for subclasses: any teardown beyond what `signal`-scoped listeners already cover (e.g. disconnecting a `ResizeObserver`, whose `.disconnect()` isn't an `AbortSignal` consumer). Called after the connection's `AbortController` has already fired. */
  protected onDisconnect(): void {}

  /** Re-renders the element's shadow DOM from current state. Must be idempotent and focus-safe (use {@link setShadowHtml}, never `shadowRoot.innerHTML =` directly). */
  protected abstract render(): void;

  protected ensureShadowRoot(): ShadowRoot {
    return this.shadowRoot ?? this.attachShadow({ mode: "open" });
  }

  /** Replaces the shadow root's markup while preserving focus + text selection inside it (see the class doc — this is the SSR-patch-safe primitive). */
  protected setShadowHtml(html: string): void {
    const root = this.ensureShadowRoot();
    const focus = captureFocus(root);
    root.innerHTML = html;
    restoreFocus(root, focus);
  }

  /** Adds an event listener that is automatically removed on `disconnectedCallback` — the only sanctioned way subclasses add listeners, so cleanup is structural rather than remembered. */
  protected listen<K extends keyof HTMLElementEventMap>(
    target: EventTarget,
    type: K | (string & {}),
    listener: (event: Event) => void,
    options?: AddEventListenerOptions,
  ): void {
    const signal = this.connectedSignal;
    if (!signal) return;
    target.addEventListener(type as string, listener, { ...options, signal });
  }

  protected dispatchTypedEvent<D>(name: string, detail: D): void {
    this.dispatchEvent(new CustomEvent<D>(name, { bubbles: true, composed: true, detail }));
  }
}
