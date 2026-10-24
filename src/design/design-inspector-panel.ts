import type { CompositionController } from "../composition/controller.js";
import { compositionTargetKey } from "../composition/model.js";
import { captureFocus, restoreFocus } from "../elements/base-element.js";
import type { HonuaStudioCanvasElement } from "../elements/studio-canvas-element.js";
import type { MapStyleField } from "../styles/map-style-edit.js";
import {
  type DesignConsumer,
  type SourceDescription,
  designConnections,
  designConsumers,
  designRemovalImpact,
} from "./design-inventory.js";

export interface DesignInspectorOptions {
  readonly container: HTMLElement;
  readonly controller: CompositionController;
  readonly canvas?: HonuaStudioCanvasElement;
  readonly describeSource: (id: string, signal: AbortSignal) => Promise<readonly MapStyleField[]>;
  readonly select: (consumer: DesignConsumer, relationshipId?: string) => void;
  readonly close: () => void;
}

const escapeHtml = (value: unknown) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Transient authorized metadata only. The controller/runtime remain the sole state owners. */
export class DesignInspectorPanel {
  readonly #options: DesignInspectorOptions;
  readonly #abort = new AbortController();
  readonly #metadata = new Map<string, SourceDescription>();
  readonly #requests = new Map<string, AbortController>();
  readonly #unsubscribe: () => void;
  #disposed = false;

  constructor(options: DesignInspectorOptions) {
    this.#options = options;
    this.#unsubscribe = options.controller.subscribe(() => queueMicrotask(() => this.refresh()));
    options.container.addEventListener("click", (event) => this.#click(event), { signal: this.#abort.signal });
    options.container.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          options.close();
        }
      },
      { signal: this.#abort.signal },
    );
    options.canvas?.addEventListener("honua-studio-design-runtime-change", () => this.refresh(), {
      signal: this.#abort.signal,
    });
    options.canvas?.addEventListener("honua-studio-widget-data-change", () => this.refresh(), {
      signal: this.#abort.signal,
    });
    this.refresh();
  }

  dispose(): void {
    this.#disposed = true;
    this.#abort.abort();
    this.#unsubscribe();
    for (const request of this.#requests.values()) request.abort();
    this.#requests.clear();
    this.#metadata.clear();
    this.#options.container.replaceChildren();
  }

  #consumers(): readonly DesignConsumer[] {
    return designConsumers(
      this.#options.controller.state,
      this.#options.canvas?.widgetDeck?.inspectInferredTableFields(),
    );
  }

  refresh(): void {
    if (this.#disposed) return;
    const consumers = this.#consumers();
    const ids = new Set(consumers.flatMap((consumer) => (consumer.sourceId ? [consumer.sourceId] : [])));
    for (const [id, request] of this.#requests)
      if (!ids.has(id)) {
        request.abort();
        this.#requests.delete(id);
        this.#metadata.delete(id);
      }
    for (const id of this.#metadata.keys()) if (!ids.has(id)) this.#metadata.delete(id);
    // Serial metadata work bounds concurrency. No feature fetches are initiated by the inspector.
    for (const id of ids) {
      if (this.#metadata.has(id)) continue;
      this.#metadata.set(id, { status: "loading", reason: "Waiting for authorized field description." });
    }
    this.#render(consumers);
    if (this.#requests.size === 0) {
      const next = [...ids].find((id) => this.#metadata.get(id)?.status === "loading");
      if (next) void this.#load(next);
    }
  }

  async #load(id: string): Promise<void> {
    const request = new AbortController();
    this.#requests.set(id, request);
    const timeout = setTimeout(() => request.abort(), 8000);
    try {
      const fields = await this.#options.describeSource(id, request.signal);
      if (!this.#disposed && this.#requests.get(id) === request && !request.signal.aborted)
        this.#metadata.set(id, { status: "ready", fields });
      else if (!this.#disposed && this.#requests.get(id) === request)
        this.#metadata.set(id, { status: "unavailable", reason: "Field description timed out. Refresh to retry." });
    } catch (error) {
      if (!this.#disposed && this.#requests.get(id) === request)
        this.#metadata.set(id, {
          status: "unavailable",
          reason: error instanceof Error ? error.message : String(error),
        });
    } finally {
      clearTimeout(timeout);
      if (this.#requests.get(id) === request) this.#requests.delete(id);
      this.refresh();
    }
  }

  #click(event: Event): void {
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (action === "close") {
      this.#options.close();
      return;
    }
    if (action === "refresh") {
      for (const request of this.#requests.values()) request.abort();
      this.#requests.clear();
      this.#metadata.clear();
      this.refresh();
      return;
    }
    if (action === "reset") {
      this.#options.canvas?.interactions?.resetTemporaryFilters();
      this.refresh();
      return;
    }
    const consumer = this.#consumers().find((entry) => entry.ref === button.dataset.ref);
    if (consumer) this.#options.select(consumer, button.dataset.relationship);
  }

  #render(consumers: readonly DesignConsumer[]): void {
    const { container, controller, canvas } = this.#options;
    const state = controller.state;
    const connections = designConnections(state, canvas?.interactions?.compiled, canvas?.designMapAvailable);
    const temporary = canvas?.interactions?.temporaryFilterSummary() ?? [];
    const selected = new Set(controller.selection.map(compositionTargetKey));
    const follow = (ref: string, relationshipId?: string, location = `consumer:${ref}`) => {
      const consumer = consumers.find((entry) => entry.ref === ref);
      return consumer
        ? `<button type="button" id="design-follow-${escapeHtml(encodeURIComponent(location))}" data-action="select" data-ref="${escapeHtml(ref)}" ${relationshipId ? `data-relationship="${escapeHtml(relationshipId)}"` : ""} aria-pressed="${selected.has(compositionTargetKey(consumer.target))}">${escapeHtml(consumer.title)} (${escapeHtml(ref)})</button>`
        : `<span>${escapeHtml(ref)} — ${ref === "map" ? "map viewport" : "unresolved reference"}</span>`;
    };
    const sources = [...new Set(consumers.flatMap((entry) => (entry.sourceId ? [entry.sourceId] : [])))];
    const focus =
      container.getRootNode() instanceof ShadowRoot ? captureFocus(container.getRootNode() as ShadowRoot) : undefined;
    const expanded = new Set(
      [...container.querySelectorAll<HTMLDetailsElement>("details[open][data-impact]")].map(
        (details) => details.dataset.impact,
      ),
    );
    container.innerHTML = `<style>
      .design-inspector{padding:1rem;border:1px solid var(--hn-line,#aaa);max-height:70vh;overflow:auto;background:var(--hn-surface,#fff);color:var(--hn-ink,#222)}
      .design-inspector button{font:inherit;margin:.2rem;padding:.3rem .6rem;cursor:pointer}.design-inspector button:focus-visible{outline:3px solid #2870ba;outline-offset:2px}
      .design-inspector li{margin:.5rem 0}.design-inspector code{overflow-wrap:anywhere}.design-inspector [aria-pressed=true]{font-weight:bold;text-decoration:underline}
    </style><section class="design-inspector" aria-label="Data and interaction inspector" data-testid="design-inspector">
      <h2>Data and interactions</h2><button type="button" data-action="close">Close inspector</button><button type="button" data-action="refresh">Refresh authorized fields</button>
      <p>Inspecting the current draft. Select an object or follow a connection to use it in the shared conversation.</p>
      <h3>Sources and field consumers</h3>
      <p>Map requests use pages of up to 2,000 features and a 32-page preview bound; tables and charts use loaded bounded rows (default 500). Counts describe loaded rows, never complete-dataset totals. Table paging does not request the full source.</p>
      <p role="status" aria-live="polite">${[...this.#metadata.values()].filter((description) => description.status === "ready").length} of ${sources.length} source field descriptions available.</p>
      ${sources
        .map((source) => {
          const description = this.#metadata.get(source);
          const data = canvas?.widgetDeck?.inspectSourceData(source);
          return `<section aria-label="Source ${escapeHtml(source)}"><h4>Source <code>${escapeHtml(source)}</code></h4>
          <p>${description?.status === "ready" ? `Described fields: ${description.fields.map((field) => `${escapeHtml(field.name)} (${escapeHtml(field.type)})`).join(", ") || "none"}` : `Fields unavailable: ${escapeHtml(description?.reason ?? "Not described")}`}</p>
          ${data ? `<p>${escapeHtml(data)}</p>` : ""}
          <ul>${consumers
            .filter((entry) => entry.sourceId === source)
            .map((entry) => this.#consumer(entry, follow, description))
            .join("")}</ul></section>`;
        })
        .join("")}
      ${
        consumers.some((entry) => !entry.sourceId)
          ? `<h4>Other components and unresolved sources</h4><ul>${consumers
              .filter((entry) => !entry.sourceId)
              .map((entry) => this.#consumer(entry, follow))
              .join("")}</ul>`
          : ""
      }
      ${consumers.length === 0 ? "<p>No components in this draft.</p>" : ""}
      <h3>Connections</h3><p>${connections.filter((entry) => entry.status === "supported").length} of ${connections.length} described connections supported by this runtime. Shared source filters are intrinsic; authored actions execute once per gesture.</p>
      <ul>${connections.map((connection) => `<li data-connection="${escapeHtml(connection.id)}" data-connection-origin="${connection.origin}"><code>${escapeHtml(connection.id)}</code>: ${follow(connection.from, connection.authoredInteractionId, JSON.stringify([connection.origin, connection.id, "from"]))} → <strong>${escapeHtml(connection.event)} → ${escapeHtml(connection.action)}</strong> → ${follow(connection.to, connection.authoredInteractionId, JSON.stringify([connection.origin, connection.id, "to"]))}<br><span>${escapeHtml(connection.behavior)} · ${escapeHtml(connection.status)}: ${escapeHtml(connection.reason)}</span></li>`).join("") || "<li>No authored or source-filter connections.</li>"}</ul>
      <h3>Temporary exploration filters</h3><ul>${temporary.map((entry) => `<li>${escapeHtml(entry.controlId)}: ${escapeHtml(entry.label)} — sources ${escapeHtml(entry.sourceIds.join(", "))}</li>`).join("") || "<li>No temporary source filters.</li>"}</ul>
      <button type="button" data-action="reset" ${temporary.length ? "" : "disabled"}>Reset temporary filters</button><p>Reset uses the existing exploration reset and preserves authored constraints, controls and interaction bindings. Layer-specific action filters remain local to their layer.</p>
    </section>`;
    for (const details of container.querySelectorAll<HTMLDetailsElement>("details[data-impact]"))
      details.open = expanded.has(details.dataset.impact);
    if (container.getRootNode() instanceof ShadowRoot) restoreFocus(container.getRootNode() as ShadowRoot, focus);
  }

  #consumer(entry: DesignConsumer, follow: (ref: string) => string, description?: SourceDescription): string {
    const missing =
      description?.status === "ready"
        ? entry.fields.filter((field) => !description.fields.some((actual) => actual.name === field))
        : [];
    const impact = designRemovalImpact(this.#options.controller.state, entry.ref);
    const connections = designConnections(
      this.#options.controller.state,
      this.#options.canvas?.interactions?.compiled,
      this.#options.canvas?.designMapAvailable,
    );
    const layerStatus =
      entry.target.kind === "layer" ? this.#options.canvas?.designLayerStatus(entry.target.id) : undefined;
    const incoming = connections.filter((connection) => connection.to === entry.ref).map((connection) => connection.id);
    const outgoing = connections
      .filter((connection) => connection.from === entry.ref)
      .map((connection) => connection.id);
    return `<li>${follow(entry.ref)}<p>Fields used: ${entry.fields.map(escapeHtml).join(", ") || "No explicit data fields"}. ${missing.length ? `Unavailable fields: ${missing.map(escapeHtml).join(", ")}.` : ""}${entry.sourceReference && !entry.sourceId ? `Unresolved or ambiguous source reference: ${escapeHtml(entry.sourceReference)}.` : ""} ${escapeHtml(entry.note ?? "")}</p>
      ${layerStatus ? `<p>Map rendering unavailable: ${escapeHtml(layerStatus)}</p>` : ""}
      <p>Authored constraints: ${entry.constraints.map((filter) => `<code>${escapeHtml(filter)}</code>`).join("; ") || "None in the available canonical style"}.</p>
      <p>Incoming: ${incoming.map(escapeHtml).join(", ") || "none"}. Outgoing: ${outgoing.map(escapeHtml).join(", ") || "none"}.</p>
      <details data-impact="${escapeHtml(entry.ref)}"><summary id="design-impact-${escapeHtml(encodeURIComponent(entry.ref))}">Removal and source-change impact for ${escapeHtml(entry.ref)}</summary><p>Affected objects: ${impact.map(escapeHtml).join(", ") || "No explicit dependents"}. Existing typed-command validation applies. Removing a referenced control refuses unless its bindings are explicitly removed or cascaded. Accepted layer/widget removal retains references, which become visibly unresolved; no replacement source is chosen.</p></details></li>`;
  }
}
