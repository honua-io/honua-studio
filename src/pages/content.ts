/**
 * The `/content` route (honua-studio#9 build item 5): composes
 * `<honua-studio-content-browser>` and `<honua-studio-lifecycle-panel>` into
 * one browse <-> open-item view. No new URL path is introduced — the hash
 * router (`src/router/router.ts`) only matches static paths — so which of
 * the two elements is visible is view-local state toggled by the browser's
 * own `honua-studio-open-item` event, rebuilt fresh on every route render
 * exactly like `renderHome`/`renderAbout`'s existing full-rebuild
 * convention.
 */
import type { AuthSession } from "../auth/index.js";
import { registerStudioElement } from "../elements/registry.js";
import type { HonuaStudioContentBrowserElement } from "../elements/studio-content-browser-element.js";
import type { HonuaStudioLifecyclePanelElement } from "../elements/studio-lifecycle-panel-element.js";
import type { HonuaStudioOpenItemDetail } from "../elements/types.js";

export function renderContent(root: HTMLElement, auth: AuthSession): void {
  registerStudioElement("honua-studio-content-browser");
  registerStudioElement("honua-studio-lifecycle-panel");

  root.innerHTML = `
    <section class="hn-panel view-section" aria-labelledby="content-heading" data-testid="content-route">
      <h2 id="content-heading" class="hn-panel-title">Content</h2>
      <p class="hn-muted">Studio content items and drafts — package lifecycle: draft, version, publish, rollback.</p>
      <div data-testid="content-route-browser"></div>
      <div data-testid="content-route-panel" hidden>
        <button type="button" class="hn-btn hn-btn--sm" data-testid="content-route-back">&larr; Back to content</button>
      </div>
    </section>
  `;

  const browserSlot = root.querySelector<HTMLElement>('[data-testid="content-route-browser"]');
  const panelSlot = root.querySelector<HTMLElement>('[data-testid="content-route-panel"]');
  if (!browserSlot || !panelSlot) return;

  const browser = document.createElement("honua-studio-content-browser") as HonuaStudioContentBrowserElement;
  browser.setAttribute("label", "Browse content");
  browser.auth = auth;
  browserSlot.appendChild(browser);

  const panel = document.createElement("honua-studio-lifecycle-panel") as HonuaStudioLifecyclePanelElement;
  panel.setAttribute("label", "Item lifecycle");
  panel.auth = auth;
  panelSlot.appendChild(panel);

  function showBrowser(): void {
    if (!browserSlot || !panelSlot) return;
    browserSlot.hidden = false;
    panelSlot.hidden = true;
  }

  function showPanel(): void {
    if (!browserSlot || !panelSlot) return;
    browserSlot.hidden = true;
    panelSlot.hidden = false;
  }

  panelSlot.querySelector('[data-testid="content-route-back"]')?.addEventListener("click", () => {
    showBrowser();
    browser.refresh();
  });

  browser.addEventListener("honua-studio-open-item", (event) => {
    const detail = (event as CustomEvent<HonuaStudioOpenItemDetail>).detail;
    panel.itemId = detail.itemId;
    panel.draftId = detail.draftId;
    showPanel();
  });
}
