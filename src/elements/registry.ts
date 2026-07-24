/**
 * Registration for the `honua-studio-*` custom elements (honua-studio#5
 * REQ-001 "registry discipline") — mirrors the guard honua-sdk-js's
 * `src/web-components/elements.ts` (`defineIfMissing`) and
 * `src/controls/registry.ts` already use: every element module
 * (studio-app-element.ts, studio-chat-element.ts, studio-canvas-element.ts)
 * only ever exports a class. None of them call `customElements.define` at
 * module scope, and neither does this module on import — registration is
 * always an explicit call to {@link registerStudioElement} or
 * {@link registerAllStudioElements}, so importing any of these modules (or
 * this file) is side-effect-free, and re-registering an already-defined tag
 * (a second host page, a hot-reloaded module, a test re-import) is always a
 * no-op rather than a `NotSupportedError`.
 */
import { HonuaStudioActivityLogElement } from "./studio-activity-log-element.js";
import { HonuaStudioAppElement } from "./studio-app-element.js";
import { HonuaStudioCanvasElement } from "./studio-canvas-element.js";
import { HonuaStudioChatElement } from "./studio-chat-element.js";
import { HonuaStudioContentBrowserElement } from "./studio-content-browser-element.js";
import { HonuaStudioLifecyclePanelElement } from "./studio-lifecycle-panel-element.js";
import type { HonuaStudioComponentRegistry } from "./types.js";

export type { HonuaStudioComponentRegistry } from "./types.js";

/**
 * Every tag this kit owns, keyed for both the blanket
 * {@link registerAllStudioElements} registration and per-tag
 * {@link registerStudioElement} lookups. Composition order — the app
 * element is registered last since it's the one whose shadow template may
 * reference the other two by tag name (upgrade order doesn't actually
 * matter for custom elements, but this keeps the map's iteration order
 * legible as "leaf surfaces, then the shell that composes them").
 */
const STUDIO_ELEMENTS: ReadonlyMap<string, CustomElementConstructor> = new Map<string, CustomElementConstructor>([
  ["honua-studio-chat", HonuaStudioChatElement],
  ["honua-studio-activity-log", HonuaStudioActivityLogElement],
  ["honua-studio-canvas", HonuaStudioCanvasElement],
  ["honua-studio-content-browser", HonuaStudioContentBrowserElement],
  ["honua-studio-lifecycle-panel", HonuaStudioLifecyclePanelElement],
  ["honua-studio-app", HonuaStudioAppElement],
]);

/** Every tag {@link registerAllStudioElements} will define — useful for asserting expected coverage in tests/docs. */
export const STUDIO_ELEMENT_TAGS: readonly string[] = Array.from(STUDIO_ELEMENTS.keys());

function defineIfMissing(
  registry: HonuaStudioComponentRegistry,
  tagName: string,
  ctor: CustomElementConstructor,
): void {
  if (!registry.get(tagName)) (registry as CustomElementRegistry).define(tagName, ctor);
}

/** Thrown by {@link registerStudioElement} for a tag this kit doesn't own. */
export class HonuaStudioElementRegistryError extends Error {
  public constructor(tagName: string) {
    super(`Unknown Honua Studio element tag "${tagName}".`);
    this.name = "HonuaStudioElementRegistryError";
  }
}

/** Registers a single tag, e.g. `"honua-studio-canvas"`. No-ops if already defined. Throws {@link HonuaStudioElementRegistryError} for an unknown tag. */
export function registerStudioElement(
  tagName: string,
  registry: HonuaStudioComponentRegistry = globalRegistry(),
): void {
  const ctor = STUDIO_ELEMENTS.get(tagName);
  if (!ctor) throw new HonuaStudioElementRegistryError(tagName);
  defineIfMissing(registry, tagName, ctor);
}

/** Registers every `honua-studio-*` tag. The bootstrap (src/main.ts) calls this explicitly — nothing in this package auto-registers on import. */
export function registerAllStudioElements(registry: HonuaStudioComponentRegistry = globalRegistry()): void {
  for (const [tagName, ctor] of STUDIO_ELEMENTS) defineIfMissing(registry, tagName, ctor);
}

/**
 * Creates a fresh, isolated component registry — a real scoped
 * `CustomElementRegistry` where the runtime supports constructing one,
 * otherwise an in-memory `{ get, define }` stand-in with the same
 * define-once-per-tag idempotency. Mirrors
 * `honua-sdk-js/src/controls/registry.ts`'s `createComponentRegistry`.
 * Useful for tests that want isolation from the page's real
 * `customElements` registry, and for a host that wants Studio's tags kept
 * out of its own global registry entirely.
 */
export function createStudioComponentRegistry(): HonuaStudioComponentRegistry {
  const registryCtor = (globalThis as { CustomElementRegistry?: new () => CustomElementRegistry })
    .CustomElementRegistry;
  if (typeof registryCtor === "function") {
    try {
      return new registryCtor();
    } catch {
      // Some runtimes expose the constructor without allowing construction; fall through.
    }
  }
  const defined = new Map<string, CustomElementConstructor>();
  return {
    get: (tagName: string) => defined.get(tagName),
    define: (tagName: string, ctor: CustomElementConstructor) => {
      if (defined.has(tagName)) return;
      defined.set(tagName, ctor);
    },
  };
}

function globalRegistry(): HonuaStudioComponentRegistry {
  if (typeof customElements === "undefined") {
    throw new Error("honua-studio elements require a DOM with window.customElements (no server-side registration).");
  }
  return customElements;
}
