/**
 * Shadow-scoped CSS for the `honua-studio-*` elements. Every rule reads
 * `--hn-*` custom properties from src/theme/tokens.css + the active theme
 * set (theme-standalone.css / theme-console.css) — those files are
 * unchanged by honua-studio#5, because their selectors already match
 * `[data-theme-set="…"]` on ANY element carrying the attribute, not only
 * `:root`. That is what lets each element scope theming to itself
 * (`this.setAttribute("data-theme-set", …)`) instead of the host's `<html>`:
 * custom properties inherit across the shadow boundary from whichever
 * ancestor — host `<html>` in the standalone shell, or the element itself in
 * an embed — carries the matching attribute. See docs/element-contract.md
 * ("Theming").
 */

/** Host-scoped reset + base typography every element's shadow root gets. */
export function baseElementStyles(): string {
  return `
    :host {
      display: block;
      box-sizing: border-box;
      font-family: var(--hn-font-ui, system-ui, sans-serif);
      font-size: var(--hn-text-body, 0.875rem);
      line-height: var(--hn-leading-body, 1.5);
      color: var(--hn-ink, #16211c);
      color-scheme: light dark;
    }
    :host *, :host *::before, :host *::after {
      box-sizing: border-box;
    }
    :host(:not([theme-connected])) {
      /* No token CSS reached this element yet (host forgot to load it) — stay legible instead of silently mis-themed. */
      color: canvastext;
      background: canvas;
    }
    a { color: var(--hn-link, #0b6b4d); }
    :focus-visible {
      outline: 2px solid var(--hn-focus, #0b6b4d);
      outline-offset: 2px;
    }
    .hn-register {
      font-size: var(--hn-text-register, 0.6875rem);
      letter-spacing: var(--hn-tracking-register, 0.08em);
      text-transform: uppercase;
      color: var(--hn-ink-muted, #5f6e66);
      margin: 0;
    }
    .hn-muted { color: var(--hn-ink-muted, #5f6e66); }
    .hn-error { color: var(--hn-critical-text, #9c2828); }
    .hn-panel {
      background: var(--hn-surface, #fdfdfc);
      border: 1px solid var(--hn-line, #dfe4df);
      border-radius: var(--hn-radius-lg, 10px);
      box-shadow: var(--hn-elevation-1, 0 1px 2px rgba(0,0,0,.08));
      padding: var(--hn-space-5, 24px);
    }
    .hn-panel-title {
      font-size: var(--hn-text-h2, 1.375rem);
      font-weight: 600;
      letter-spacing: var(--hn-tracking-heading, -0.02em);
      margin: 0 0 var(--hn-space-2, 8px);
    }
    .hn-btn {
      appearance: none;
      border: 1px solid var(--hn-border-control, #7c8a81);
      background: var(--hn-surface-raised, #fff);
      color: var(--hn-ink, #16211c);
      border-radius: var(--hn-radius, 6px);
      height: var(--hn-control-height, 2.25rem);
      padding: 0 var(--hn-space-4, 16px);
      font: inherit;
      cursor: pointer;
      transition: background-color var(--hn-motion-fast, 120ms) var(--hn-ease, ease),
        border-color var(--hn-motion-fast, 120ms) var(--hn-ease, ease);
    }
    .hn-btn:hover { border-color: var(--hn-accent, #0b6b4d); }
    .hn-btn[aria-pressed="true"] {
      background: var(--hn-accent, #0b6b4d);
      border-color: var(--hn-accent, #0b6b4d);
      color: var(--hn-accent-ink, #fff);
    }
    .hn-btn--sm {
      height: calc(var(--hn-control-height, 2.25rem) - var(--hn-space-2, 8px));
      padding: 0 var(--hn-space-3, 12px);
      font-size: var(--hn-text-sm, 0.8125rem);
    }
    .hn-badge {
      display: inline-flex;
      align-items: center;
      border-radius: var(--hn-radius-pill, 999px);
      background: var(--hn-neutral-tint, #e8ece8);
      color: var(--hn-neutral-text, #46554d);
      font-size: var(--hn-text-xs, 0.75rem);
      padding: var(--hn-space-0, 2px) var(--hn-space-2, 8px);
      margin-right: var(--hn-space-2, 8px);
    }
    .hn-badge--status { background: var(--hn-info-tint, #dfe9f8); color: var(--hn-info-text, #1c5cab); }
  `;
}

export function appShellStyles(): string {
  return `
    .app-shell { display: flex; flex-direction: column; gap: var(--hn-space-5, 24px); }
    .app-header {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
      gap: var(--hn-space-4, 16px);
    }
    .app-brand { display: flex; flex-direction: column; gap: var(--hn-space-1, 4px); }
    .app-title {
      font-family: var(--hn-font-display, inherit);
      font-size: var(--hn-text-h1, 1.75rem);
      letter-spacing: var(--hn-tracking-heading, -0.02em);
      margin: 0;
    }
    .app-nav { display: flex; gap: var(--hn-space-4, 16px); }
    .app-nav a { text-decoration: none; font-size: var(--hn-text-sm, .8125rem); color: var(--hn-ink-secondary, #46554d); }
    .app-nav a:hover { color: var(--hn-accent, #0b6b4d); }
    .app-nav a[aria-current="page"] { color: var(--hn-accent, #0b6b4d); font-weight: 600; }
    .app-auth { display: flex; align-items: center; gap: var(--hn-space-3, 12px); }
    .app-theme-controls { display: flex; flex-wrap: wrap; gap: var(--hn-space-3, 12px); }
    .theme-group {
      display: flex; gap: var(--hn-space-1, 4px);
      background: var(--hn-surface-sunken, #e9ede9);
      border-radius: var(--hn-radius, 6px);
      padding: var(--hn-space-0, 2px);
    }
    .app-view {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
      gap: var(--hn-space-5, 24px); align-items: start;
    }
    .view-section { display: flex; flex-direction: column; gap: var(--hn-space-3, 12px); }
    .entity-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--hn-space-2, 8px); }
    .entity-list li { border-bottom: 1px solid var(--hn-line, #dfe4df); padding-bottom: var(--hn-space-2, 8px); }
    .entity-list li:last-child { border-bottom: none; padding-bottom: 0; }
    .app-slots { display: flex; flex-direction: column; gap: var(--hn-space-5, 24px); }
  `;
}

export function chatStyles(): string {
  return `
    .chat { display: flex; flex-direction: column; gap: var(--hn-space-3, 12px); }
    .chat form { display: flex; gap: var(--hn-space-2, 8px); }
    .chat input[type="text"] {
      flex: 1; font: inherit; color: inherit;
      background: var(--hn-surface-raised, #fff);
      border: 1px solid var(--hn-border-control, #7c8a81);
      border-radius: var(--hn-radius, 6px);
      height: var(--hn-control-height, 2.25rem);
      padding: 0 var(--hn-space-3, 12px);
    }
    .chat-log { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--hn-space-2, 8px); max-height: 12rem; overflow-y: auto; }
    .chat-log li { border-bottom: 1px solid var(--hn-line, #dfe4df); padding-bottom: var(--hn-space-1, 4px); }
  `;
}

export function canvasStyles(): string {
  return `
    .canvas { display: flex; flex-direction: column; gap: var(--hn-space-2, 8px); min-height: 12rem; }
    .canvas-surface {
      flex: 1; min-height: 10rem;
      border: 1px dashed var(--hn-line-strong, #c2cac3);
      border-radius: var(--hn-radius-lg, 10px);
      background: var(--hn-surface-sunken, #e9ede9);
      display: flex; align-items: center; justify-content: center;
      color: var(--hn-ink-faint, #8b988f);
    }
    .composition-readout { display: flex; flex-direction: column; gap: var(--hn-space-4, 16px); }
    .composition-section { display: flex; flex-direction: column; gap: var(--hn-space-2, 8px); }
    .composition-section h3 {
      font-size: var(--hn-text-sm, 0.8125rem); font-weight: 600; margin: 0;
      color: var(--hn-ink-secondary, #46554d);
    }
    .composition-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--hn-space-1, 4px); }
    .composition-row {
      display: flex; align-items: center; justify-content: space-between; gap: var(--hn-space-2, 8px);
      width: 100%; text-align: left; font: inherit; color: inherit;
      background: var(--hn-surface-raised, #fff);
      border: 1px solid var(--hn-line, #dfe4df);
      border-radius: var(--hn-radius, 6px);
      padding: var(--hn-space-2, 8px) var(--hn-space-3, 12px);
      cursor: pointer;
    }
    .composition-row:hover { border-color: var(--hn-accent, #0b6b4d); }
    .composition-row[aria-pressed="true"] { border-color: var(--hn-accent, #0b6b4d); background: var(--hn-accent-tint, #e3f1ea); }
    .composition-row[data-pinned="true"] { border-style: dashed; }
    .composition-empty { color: var(--hn-ink-faint, #8b988f); margin: 0; }
    .composition-view-fields { display: flex; flex-wrap: wrap; gap: var(--hn-space-2, 8px); margin: 0; padding: 0; list-style: none; }
    .composition-view-fields li { font-size: var(--hn-text-sm, 0.8125rem); }
  `;
}
