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
    /* honua-studio#23 REQ-004 — the live-composition control group. */
    .app-composition-mode { display: flex; align-items: center; gap: var(--hn-space-2, 8px); position: relative; }
    .app-composition-mode .hn-badge[data-mode="live"] {
      background: var(--hn-accent-tint, #e3f1ea); color: var(--hn-accent, #0b6b4d);
    }
    .live-form {
      position: absolute; top: calc(100% + var(--hn-space-2, 8px)); right: 0; z-index: 10;
      display: flex; flex-direction: column; gap: var(--hn-space-2, 8px);
      min-width: 18rem; padding: var(--hn-space-3, 12px);
      background: var(--hn-surface-raised, #fff);
      border: 1px solid var(--hn-line, #dfe4df);
      border-radius: var(--hn-radius-lg, 10px);
      box-shadow: var(--hn-shadow-raised, 0 6px 20px rgb(15 30 22 / 12%));
    }
    .live-form[hidden] { display: none; }
    .live-field { display: flex; flex-direction: column; gap: var(--hn-space-1, 4px); font-size: var(--hn-text-sm, 0.8125rem); }
    .live-field input, .live-field select {
      font: inherit; color: inherit;
      background: var(--hn-surface-raised, #fff);
      border: 1px solid var(--hn-border-control, #7c8a81);
      border-radius: var(--hn-radius, 6px);
      height: var(--hn-control-height, 2.25rem);
      padding: 0 var(--hn-space-2, 8px);
    }
    .live-actions { display: flex; gap: var(--hn-space-2, 8px); }
    .live-note { margin: 0; font-size: var(--hn-text-xs, 0.75rem); }
  `;
}

export function chatStyles(): string {
  return `
    .chat { display: flex; flex-direction: column; gap: var(--hn-space-3, 12px); }
    .chat form { display: flex; flex-direction: column; gap: var(--hn-space-2, 8px); }
    .chat-composer-row { display: flex; gap: var(--hn-space-2, 8px); }
    .chat input[type="text"] {
      flex: 1; font: inherit; color: inherit;
      background: var(--hn-surface-raised, #fff);
      border: 1px solid var(--hn-border-control, #7c8a81);
      border-radius: var(--hn-radius, 6px);
      height: var(--hn-control-height, 2.25rem);
      padding: 0 var(--hn-space-3, 12px);
    }
    .chat-log { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--hn-space-3, 12px); max-height: 24rem; overflow-y: auto; }
    .chat-message { border-bottom: 1px solid var(--hn-line, #dfe4df); padding-bottom: var(--hn-space-2, 8px); display: flex; flex-direction: column; gap: var(--hn-space-1, 4px); }
    .chat-message:last-child { border-bottom: none; padding-bottom: 0; }
    .chat-message-role { font-size: var(--hn-text-register, 0.6875rem); letter-spacing: var(--hn-tracking-register, 0.08em); text-transform: uppercase; color: var(--hn-ink-muted, #5f6e66); }
    .chat-message--user .chat-message-text { font-weight: 500; }
    .chat-message-text { white-space: pre-wrap; word-break: break-word; }
    .chat-message--streaming .chat-message-text::after { content: "▍"; opacity: 0.6; }
    .chat-message--error .chat-message-text { color: var(--hn-critical-text, #9c2828); }
    .chat-message-annotations { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--hn-space-1, 4px); }
    .chat-tool-calls { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--hn-space-2, 8px); }
    .chat-tool-call {
      border: 1px solid var(--hn-line, #dfe4df);
      border-radius: var(--hn-radius, 6px);
      background: var(--hn-surface-sunken, #e9ede9);
      padding: var(--hn-space-2, 8px) var(--hn-space-3, 12px);
      font-size: var(--hn-text-sm, 0.8125rem);
    }
    .chat-tool-call-name { font-weight: 600; }
    .chat-tool-call-args { margin: var(--hn-space-1, 4px) 0 0; white-space: pre-wrap; word-break: break-word; font-family: var(--hn-font-mono, ui-monospace, monospace); font-size: var(--hn-text-xs, 0.75rem); }
    .chat-annotations { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--hn-space-2, 8px); }
    .chat-annotation-chip {
      display: inline-flex; align-items: center; gap: var(--hn-space-1, 4px);
      border-radius: var(--hn-radius-pill, 999px);
      background: var(--hn-info-tint, #dfe9f8); color: var(--hn-info-text, #1c5cab);
      font-size: var(--hn-text-xs, 0.75rem);
      padding: var(--hn-space-0, 2px) var(--hn-space-1, 4px) var(--hn-space-0, 2px) var(--hn-space-2, 8px);
    }
    .chat-annotation-chip button {
      appearance: none; border: none; background: none; color: inherit; cursor: pointer;
      font: inherit; line-height: 1; padding: 0 var(--hn-space-1, 4px);
    }
    .chat-status-row { display: flex; align-items: center; gap: var(--hn-space-2, 8px); }
  `;
}

export function activityLogStyles(): string {
  return `
    .activity-log { display: flex; flex-direction: column; gap: var(--hn-space-3, 12px); }
    .activity-log-entries { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--hn-space-1, 4px); max-height: 20rem; overflow-y: auto; font-size: var(--hn-text-sm, 0.8125rem); }
    .activity-log-entry { border-bottom: 1px solid var(--hn-line, #dfe4df); padding-bottom: var(--hn-space-1, 4px); display: flex; gap: var(--hn-space-2, 8px); align-items: baseline; }
    .activity-log-entry:last-child { border-bottom: none; }
    .activity-log-entry-type { font-family: var(--hn-font-mono, ui-monospace, monospace); font-size: var(--hn-text-xs, 0.75rem); color: var(--hn-ink-secondary, #46554d); }
    .activity-log-entry-detail { flex: 1; color: var(--hn-ink-muted, #5f6e66); word-break: break-word; }
    .activity-log-entry--replayed { background: var(--hn-info-tint, #dfe9f8); }
    .activity-log-controls { display: flex; gap: var(--hn-space-2, 8px); flex-wrap: wrap; }
  `;
}

/** Shared shadow CSS for `<honua-studio-content-browser>` and `<honua-studio-lifecycle-panel>` (honua-studio#9). */
export function lifecycleStyles(): string {
  return `
    .lifecycle { display: flex; flex-direction: column; gap: var(--hn-space-4, 16px); }
    .lifecycle-filters { display: flex; flex-wrap: wrap; gap: var(--hn-space-2, 8px); align-items: center; }
    .lifecycle-filters select, .lifecycle-filters input[type="search"] {
      font: inherit; color: inherit;
      background: var(--hn-surface-raised, #fff);
      border: 1px solid var(--hn-border-control, #7c8a81);
      border-radius: var(--hn-radius, 6px);
      height: var(--hn-control-height, 2.25rem);
      padding: 0 var(--hn-space-3, 12px);
    }
    .lifecycle-table { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--hn-space-1, 4px); }
    .lifecycle-row {
      display: flex; align-items: center; justify-content: space-between; gap: var(--hn-space-3, 12px);
      border: 1px solid var(--hn-line, #dfe4df); border-radius: var(--hn-radius, 6px);
      background: var(--hn-surface-raised, #fff);
      padding: var(--hn-space-2, 8px) var(--hn-space-3, 12px);
    }
    .lifecycle-row-main { display: flex; flex-direction: column; gap: var(--hn-space-0, 2px); min-width: 0; }
    .lifecycle-row-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lifecycle-row-meta { display: flex; gap: var(--hn-space-2, 8px); flex-wrap: wrap; }
    .lifecycle-empty { color: var(--hn-ink-faint, #8b988f); margin: 0; }
    .lifecycle-banner {
      border: 1px solid var(--hn-warning-border, #d9a441);
      background: var(--hn-warning-tint, #fbf1dd);
      color: var(--hn-warning-text, #7a5308);
      border-radius: var(--hn-radius, 6px);
      padding: var(--hn-space-3, 12px);
      display: flex; flex-direction: column; gap: var(--hn-space-2, 8px);
    }
    .lifecycle-banner-title { font-weight: 600; }
    .lifecycle-diff-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: var(--hn-space-2, 8px); margin: 0; }
    .lifecycle-diff-item { display: flex; flex-direction: column; gap: var(--hn-space-0, 2px); font-size: var(--hn-text-sm, 0.8125rem); }
    .lifecycle-diff-item[data-equal="false"] { color: var(--hn-critical-text, #9c2828); }
    .lifecycle-confirm {
      border: 2px solid var(--hn-critical-border, #d97676);
      background: var(--hn-critical-tint, #fbe4e4);
      border-radius: var(--hn-radius-lg, 10px);
      padding: var(--hn-space-4, 16px);
      display: flex; flex-direction: column; gap: var(--hn-space-3, 12px);
    }
    .lifecycle-confirm input[type="text"] {
      font: inherit; color: inherit;
      background: var(--hn-surface-raised, #fff);
      border: 1px solid var(--hn-border-control, #7c8a81);
      border-radius: var(--hn-radius, 6px);
      height: var(--hn-control-height, 2.25rem);
      padding: 0 var(--hn-space-3, 12px);
    }
    .lifecycle-actions { display: flex; gap: var(--hn-space-2, 8px); flex-wrap: wrap; }
  `;
}

export function canvasStyles(): string {
  return `
    .canvas { display: flex; flex-direction: column; gap: var(--hn-space-2, 8px); min-height: 12rem; }
    .canvas-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--hn-space-3, 12px); }
    .canvas-surfaces { display: flex; gap: var(--hn-space-1, 4px); }
    /* honua-studio#23: the live MapLibre surface. A WebGL canvas needs a real
       height — a flex child that collapses to 0 renders nothing at all — so
       the map keeps a floor and grows into whatever the panel gives it. */
    .canvas-map {
      flex: 1 1 auto; min-height: 18rem;
      border: 1px solid var(--hn-line, #dfe4df);
      border-radius: var(--hn-radius-lg, 10px);
      overflow: hidden;
      position: relative;
      background: var(--hn-surface-sunken, #e9ede9);
    }
    .canvas-map[hidden] { display: none; }
    .canvas-map-status:empty { display: none; }
    /* honua-studio#24: the composed widget deck sits between the map and the
       readout — chrome the agent added, in the order it reads: what is on the
       map, then what analyses it, then the structural detail. It hides itself
       when the composition holds no widgets (see widgetDeckStyles). */
    .canvas-widgets { flex: 0 0 auto; }
    /* honua-studio#25: controls are chrome, so they sit ABOVE the map, in
       reading order before the thing they act on — and the bar collapses to
       nothing when the composition declares no controls. */
    .canvas-controls { flex: 0 0 auto; }
    .canvas-map-status { font-size: var(--hn-text-sm, 0.8125rem); margin: 0; }
    /* In map mode the readout is a compact table of contents under the map;
       in details mode it takes the panel. It is never hidden — see
       studio-canvas-element.ts's class doc. */
    .canvas[data-surface="map"] .composition-readout { max-height: 14rem; overflow-y: auto; }
    .composition-flag {
      font-size: var(--hn-text-xs, 0.75rem);
      color: var(--hn-warning-text, #7a5308);
      background: var(--hn-warning-tint, #fbf1dd);
      border-radius: var(--hn-radius, 6px);
      padding: 0 var(--hn-space-1, 4px);
    }
    .composition-row[data-unrendered="true"] { border-style: dashed; border-color: var(--hn-warning-border, #d9a441); }
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

/**
 * `<honua-studio-widget-deck>` (honua-studio#24) — the composed chrome:
 * layer list, legend, grid, chart, compare switch, time stepper.
 *
 * The deck is a horizontally-scrolling strip of cards rather than a grid,
 * because the number of widgets is decided by the conversation, not by a
 * layout: an agent may add one or six, and a wrapping grid would reflow the
 * map every time a tool call landed. Each card holds its own scroll, so a
 * 500-row grid never grows the panel.
 */
export function widgetDeckStyles(): string {
  return `
    :host([data-empty="true"]) { display: none; }
    .widget-deck {
      display: flex;
      gap: var(--hn-space-3, 12px);
      overflow-x: auto;
      padding-bottom: var(--hn-space-1, 4px);
      align-items: stretch;
    }
    .widget {
      display: flex; flex-direction: column; gap: var(--hn-space-2, 8px);
      flex: 0 0 auto;
      min-width: 15rem; max-width: 26rem;
      background: var(--hn-surface-raised, #fff);
      border: 1px solid var(--hn-line, #dfe4df);
      border-radius: var(--hn-radius-lg, 10px);
      padding: var(--hn-space-3, 12px);
    }
    .widget[data-widget-kind="table"], .widget[data-widget-kind="chart"] { min-width: 20rem; }
    .widget-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--hn-space-2, 8px); }
    .widget-title { font-size: var(--hn-text-sm, 0.8125rem); font-weight: 600; margin: 0; }
    .widget-kind { flex: 0 0 auto; }
    .widget-body { display: flex; flex-direction: column; gap: var(--hn-space-2, 8px); min-height: 0; }
    .widget-status { font-size: var(--hn-text-xs, 0.75rem); margin: 0; }
    .widget-empty { margin: 0; font-size: var(--hn-text-sm, 0.8125rem); }
    .widget-swatch {
      display: inline-block; flex: 0 0 auto;
      width: 0.75rem; height: 0.75rem; border-radius: 3px;
      border: 1px solid rgba(0, 0, 0, 0.15);
    }
    .widget-flag {
      font-size: var(--hn-text-xs, 0.75rem);
      color: var(--hn-warning-text, #7a5308);
      background: var(--hn-warning-tint, #fbf1dd);
      border-radius: var(--hn-radius, 6px);
      padding: 0 var(--hn-space-1, 4px);
    }

    /* Layer list + legend */
    .widget-toc, .widget-legend {
      list-style: none; margin: 0; padding: 0;
      display: flex; flex-direction: column; gap: var(--hn-space-1, 4px);
      max-height: 12rem; overflow-y: auto;
    }
    .widget-toc-row { display: flex; align-items: center; gap: var(--hn-space-2, 8px); }
    .widget-toc-toggle { flex: 0 0 auto; accent-color: var(--hn-accent, #0b6b4d); cursor: pointer; }
    .widget-toc-toggle:disabled { cursor: not-allowed; }
    .widget-toc-label {
      display: flex; align-items: center; gap: var(--hn-space-2, 8px);
      flex: 1 1 auto; min-width: 0;
      text-align: left; font: inherit; color: inherit;
      background: none; border: 1px solid transparent;
      border-radius: var(--hn-radius, 6px);
      padding: var(--hn-space-1, 4px) var(--hn-space-2, 8px);
      cursor: pointer;
    }
    .widget-toc-label:hover { border-color: var(--hn-accent, #0b6b4d); }
    .widget-toc-label[aria-pressed="true"] {
      border-color: var(--hn-accent, #0b6b4d);
      background: var(--hn-accent-tint, #e3f1ea);
    }
    .widget-toc-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .widget-toc-row[data-visible="false"] .widget-toc-name { color: var(--hn-ink-faint, #8b988f); }
    .widget-legend-item { display: flex; align-items: center; gap: var(--hn-space-2, 8px); font-size: var(--hn-text-sm, 0.8125rem); }
    .widget-legend-item[data-hidden="true"] { opacity: 0.55; }
    .widget-legend-style { font-size: var(--hn-text-xs, 0.75rem); }

    /* Data grid */
    .widget-grid-scroll { overflow: auto; max-height: 14rem; border: 1px solid var(--hn-line, #dfe4df); border-radius: var(--hn-radius, 6px); }
    .widget-grid { border-collapse: collapse; width: 100%; font-size: var(--hn-text-xs, 0.75rem); }
    .widget-grid th, .widget-grid td {
      text-align: left; padding: var(--hn-space-1, 4px) var(--hn-space-2, 8px);
      border-bottom: 1px solid var(--hn-line, #dfe4df);
      white-space: nowrap;
    }
    .widget-grid thead th {
      position: sticky; top: 0; z-index: 1;
      background: var(--hn-surface-sunken, #e9ede9);
      font-weight: 600;
    }
    .widget-grid tbody tr[data-action] { cursor: pointer; }
    .widget-grid tbody tr[data-action]:hover { background: var(--hn-surface-sunken, #e9ede9); }
    .widget-grid tbody tr[aria-selected="true"] { background: var(--hn-accent-tint, #e3f1ea); }
    .widget-pager { display: flex; align-items: center; justify-content: space-between; gap: var(--hn-space-2, 8px); font-size: var(--hn-text-xs, 0.75rem); }

    /* Chart */
    .widget-chart { margin: 0; display: flex; flex-direction: column; gap: var(--hn-space-1, 4px); }
    .widget-chart-svg { width: 100%; height: auto; overflow: visible; }
    .widget-chart-grid { stroke: var(--hn-line, #dfe4df); stroke-width: 0.5; }
    .widget-chart-tick, .widget-chart-label { font-size: 7px; fill: var(--hn-ink-muted, #5f6e66); font-family: var(--hn-font-ui, system-ui, sans-serif); }
    .widget-chart figcaption { font-size: var(--hn-text-xs, 0.75rem); }

    /* Compare + time */
    .widget-compare { display: flex; gap: var(--hn-space-1, 4px); flex-wrap: wrap; }
    .widget-compare-option { flex: 1 1 auto; }
    .widget-time { display: flex; align-items: center; gap: var(--hn-space-2, 8px); }
    .widget-time-slider { flex: 1 1 auto; accent-color: var(--hn-accent, #0b6b4d); }
    .widget-time-label { font-size: var(--hn-text-sm, 0.8125rem); font-variant-numeric: tabular-nums; }
  `;
}

/**
 * `<honua-studio-control-bar>` (honua-studio#25) — the controls collection.
 *
 * A wrapping row of small cards rather than the deck's scrolling strip: ADR-0031
 * calls controls *chrome*, and chrome that scrolls sideways hides itself. A
 * navigation cluster and a scale bar are a few dozen pixels each, so the bar
 * wraps and stays entirely visible at any width — which is also what lets it
 * sit directly above the map without stealing height from it.
 */
export function controlBarStyles(): string {
  return `
    :host([data-empty="true"]) { display: none; }
    .control-bar {
      display: flex; flex-wrap: wrap;
      gap: var(--hn-space-2, 8px);
      align-items: flex-start;
    }
    .control {
      display: flex; flex-direction: column; gap: var(--hn-space-1, 4px);
      flex: 0 1 auto; min-width: 8rem; max-width: 22rem;
      background: var(--hn-surface-raised, #fff);
      border: 1px solid var(--hn-line, #dfe4df);
      border-radius: var(--hn-radius-lg, 10px);
      padding: var(--hn-space-2, 8px) var(--hn-space-3, 12px);
    }
    .control[data-state="unsupported"] {
      border-style: dashed;
      border-color: var(--hn-warning-border, #d9a441);
      background: var(--hn-warning-tint, #fbf1dd);
    }
    .control-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--hn-space-2, 8px); }
    .control-title { font-size: var(--hn-text-sm, 0.8125rem); font-weight: 600; margin: 0; }
    .control-kind { flex: 0 0 auto; font-family: var(--hn-font-mono, ui-monospace, monospace); }
    .control-body { display: flex; flex-direction: column; gap: var(--hn-space-1, 4px); }
    .control-status, .control-note { font-size: var(--hn-text-xs, 0.75rem); margin: 0; }
    .control-row { display: flex; gap: var(--hn-space-1, 4px); flex-wrap: wrap; }
    .control-icon { min-width: 2.25rem; padding: 0 var(--hn-space-2, 8px); font-variant-numeric: tabular-nums; }
    .control-field { display: flex; align-items: center; gap: var(--hn-space-2, 8px); }
    .control-field--range { flex-wrap: wrap; }
    .control-label { font-size: var(--hn-text-xs, 0.75rem); color: var(--hn-ink-muted, #5f6e66); }
    .control-slider { flex: 1 1 auto; min-width: 6rem; accent-color: var(--hn-accent, #0b6b4d); }
    .control-select, .control-field input[type="date"] {
      font: inherit; color: inherit;
      background: var(--hn-surface-raised, #fff);
      border: 1px solid var(--hn-border-control, #7c8a81);
      border-radius: var(--hn-radius, 6px);
      height: calc(var(--hn-control-height, 2.25rem) - var(--hn-space-2, 8px));
      padding: 0 var(--hn-space-2, 8px);
      max-width: 100%;
    }
    .control-value, .control-measure-value {
      font-size: var(--hn-text-sm, 0.8125rem);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    /* The scale bar is a real measurement: the rule's width IS the distance. */
    .control-scale { display: flex; align-items: center; gap: var(--hn-space-2, 8px); }
    .control-scale-bar {
      display: inline-block; height: 0.5rem;
      border: 1px solid var(--hn-ink-secondary, #46554d);
      border-top: none;
    }
    .control-scale-label { font-size: var(--hn-text-xs, 0.75rem); font-variant-numeric: tabular-nums; }
    .control-attribution {
      list-style: none; margin: 0; padding: 0;
      display: flex; flex-direction: column; gap: 2px;
      font-size: var(--hn-text-xs, 0.75rem); color: var(--hn-ink-muted, #5f6e66);
    }
    .control-bookmarks { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--hn-space-1, 4px); }
    .control-measure { display: flex; align-items: center; gap: var(--hn-space-2, 8px); flex-wrap: wrap; }
    .control-measure[data-active="true"] { outline: 2px solid var(--hn-accent, #0b6b4d); outline-offset: 4px; }
  `;
}

/** `<honua-studio-gp-panel>` (honua-studio#10) — reuses `.lifecycle-*`/`.hn-*` class names from {@link lifecycleStyles} for the shared draft/validation/confirm-dialog chrome; this adds the GP-specific bits (inputs/parameters/outputs tables, job progress). */
export function gpPanelStyles(): string {
  return `
    .gp-caveat {
      border: 1px solid var(--hn-warning-border, #d9a441);
      background: var(--hn-warning-tint, #fbf1dd);
      color: var(--hn-warning-text, #7a5308);
      border-radius: var(--hn-radius, 6px);
      padding: var(--hn-space-3, 12px);
      font-size: var(--hn-text-sm, 0.8125rem);
    }
    .gp-fields { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--hn-space-1, 4px); }
    .gp-field-row {
      display: flex; align-items: baseline; justify-content: space-between; gap: var(--hn-space-3, 12px);
      border: 1px solid var(--hn-line, #dfe4df); border-radius: var(--hn-radius, 6px);
      background: var(--hn-surface-raised, #fff);
      padding: var(--hn-space-2, 8px) var(--hn-space-3, 12px);
      font-size: var(--hn-text-sm, 0.8125rem);
    }
    .gp-progress {
      height: 0.5rem;
      border-radius: var(--hn-radius, 6px);
      background: var(--hn-surface-sunken, #e9ede9);
      overflow: hidden;
    }
    .gp-progress-fill { height: 100%; background: var(--hn-accent, #0b6b4d); transition: width 150ms ease; }
    .gp-status-badge[data-status="failed"] { background: var(--hn-critical-tint, #fbe4e4); color: var(--hn-critical-text, #9c2828); }
    .gp-status-badge[data-status="dismissed"] { background: var(--hn-surface-sunken, #e9ede9); color: var(--hn-ink-muted, #5f6e66); }
    .gp-status-badge[data-status="successful"] { background: var(--hn-accent-tint, #e3f1ea); color: var(--hn-accent, #0b6b4d); }
  `;
}
