/**
 * `<honua-studio-canvas>` — placeholder composition canvas surface
 * (honua-studio#5; the real composition engine is honua-studio#8). Phase 0
 * scope: prove the element contract's observer-cleanup invariant (a
 * `ResizeObserver` is exactly the kind of subscription that leaks silently
 * if `disconnectedCallback` is incomplete) and give the Blazor render-mode
 * hazard test (harness/blazor-host) something concrete to toggle: this
 * class tracks its own live instance count as a static, so a test can
 * assert "re-instantiation on render-mode switch doesn't leak or
 * double-register" by asserting the count returns to exactly what it
 * started at after a toggle-off, and never exceeds what's actually mounted
 * concurrently.
 */
import { HonuaStudioElementBase } from "./base-element.js";
import { resolveInjectedAuth } from "./session.js";
import { baseElementStyles, canvasStyles } from "./styles.js";
import type { AuthSession, HonuaStudioCanvasResizeDetail } from "./types.js";

export class HonuaStudioCanvasElement extends HonuaStudioElementBase {
  static get observedAttributes(): string[] {
    return ["label"];
  }

  /** Live (connected) instance count — a leak-detection probe, not part of the public contract proper. See the class doc and test/elements/cleanup.test.ts. */
  static instanceCount = 0;

  #auth: AuthSession | undefined;
  #resizeObserver: ResizeObserver | undefined;

  /** Direct `AuthSession` override — falls back to the nearest `<honua-studio-app>` ancestor's `.auth` when unset. See docs/embed-session.md. */
  public get auth(): AuthSession | undefined {
    return this.#auth;
  }

  public set auth(auth: AuthSession | undefined) {
    this.#auth = auth;
    this.render();
  }

  public attributeChangedCallback(): void {
    if (!this.isConnected) return;
    this.render();
  }

  protected onConnect(): void {
    HonuaStudioCanvasElement.instanceCount += 1;
    if (!this.#auth) {
      const inherited = resolveInjectedAuth(this);
      if (inherited) this.#auth = inherited;
      else this.dispatchTypedEvent("honua-studio-session-required", { reason: "honua-studio-canvas has no session" });
    }
    if (typeof ResizeObserver !== "undefined") {
      this.#resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        this.dispatchTypedEvent<HonuaStudioCanvasResizeDetail>("honua-studio-canvas-resize", {
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      });
      this.#resizeObserver.observe(this);
    }
  }

  protected onDisconnect(): void {
    HonuaStudioCanvasElement.instanceCount -= 1;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
  }

  protected render(): void {
    const label = this.getAttribute("label") ?? "Canvas";
    this.setShadowHtml(`
      <style>${baseElementStyles()}${canvasStyles()}</style>
      <section class="canvas hn-panel" part="panel" aria-label="${escapeHtml(label)}" data-testid="studio-canvas">
        <h2 class="hn-panel-title">${escapeHtml(label)}</h2>
        <div class="canvas-surface" data-testid="studio-canvas-surface" tabindex="0">
          <span>Composition canvas placeholder — honua-studio#8.</span>
        </div>
      </section>
    `);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
