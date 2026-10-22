import type { AuthSession } from "../auth/types.js";
import { CompositionController } from "../composition/controller.js";
import type { CompositionState } from "../composition/model.js";
import { compositionDataSource } from "../composition/source-reference.js";
import { HonuaStudioControlBarElement } from "../elements/studio-control-bar-element.js";
import { HonuaStudioWidgetDeckElement } from "../elements/studio-widget-deck-element.js";
import { StudioInteractionRuntime } from "../interactions/studio-interactions.js";
import { readCompositionBody } from "../lifecycle/composition-draft-store.js";
import { type WidgetDataLoader, createCatalogWidgetDataLoader } from "../widgets/widget-data.js";
import { trustedSourceUrl } from "./authenticated-source-protocol.js";
import type { CompositionMapStatus } from "./composition-map-view.js";
import type { CompositionMapProjection, CompositionMapProjectionOptions } from "./map-package-projection.js";
import {
  type ReadOnlyMapCanvas,
  type ReadOnlyMapCanvasOptions,
  startReadOnlyMapCanvasForController,
} from "./read-only-map-canvas.js";
import {
  findCompositionSourceDescriptor,
  isCompositionSourceResolution,
  resolveCompositionSource,
} from "./source-resolution.js";

const CONTROL_TAG = "honua-studio-control-bar";
const WIDGET_TAG = "honua-studio-widget-deck";
const WIDGET_FEATURE_LIMIT = 500;
const WIDGET_RESPONSE_BYTES_LIMIT = 16 * 1024 * 1024;

export interface ReadOnlyCompositionDocument {
  readonly body: unknown;
  readonly projection?: CompositionMapProjectionOptions;
}

/** A host-owned, audience-scoped GET transport. It has no bearer or writer method. */
export interface AudienceFeatureTransport {
  readonly fetchRequest: typeof fetch;
}

/** The host supplies current-reader source descriptors and a bounded GET transport. */
export interface ReadOnlyCompositionViewOptions extends Omit<ReadOnlyMapCanvasOptions, "getAuth" | "onChange"> {
  readonly widgetContainer: HTMLElement;
  readonly documentUrl?: string;
  /**
   * The object identity is the reader epoch. Keep it stable for one principal
   * and target; return a new object and reload or dispose when either changes.
   */
  readonly getAudienceTransport: () => AudienceFeatureTransport | undefined;
  readonly onChange?: (view: ReadOnlyCompositionView) => void;
}

/** One private map/widget state. Recreate with its style provider when the reader catalog changes. */
export interface ReadOnlyCompositionView {
  readonly status: CompositionMapStatus;
  readonly statusDetail: string | undefined;
  readonly projection: CompositionMapProjection | undefined;
  readonly renderedFeatureCount: number;
  /** Replace composition using the same reader/catalog epoch; new catalogs require a new view and style provider. */
  reload(document: ReadOnlyCompositionDocument): Promise<void>;
  settled(): Promise<void>;
  resize(): void;
  dispose(): void;
}

function registerWidgetDeck(container: HTMLElement, controls: boolean): void {
  const registry = container.ownerDocument.defaultView?.customElements;
  if (!registry) throw new Error("A custom-element registry is required for published widgets.");
  if (!registry.get(WIDGET_TAG)) registry.define(WIDGET_TAG, HonuaStudioWidgetDeckElement);
  if (controls && !registry.get(CONTROL_TAG)) registry.define(CONTROL_TAG, HonuaStudioControlBarElement);
}

async function boundedWidgetResponse(
  response: Response,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<Response> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > WIDGET_RESPONSE_BYTES_LIMIT) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Widget source exceeds the response size limit.");
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  let bytes = new Uint8Array(0);
  let total = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      if (!isCurrent()) throw new Error("The viewer authority changed during a widget read.");
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (!isCurrent()) throw new Error("The viewer authority changed during a widget read.");
      if (done) break;
      const nextTotal = total + value.byteLength;
      if (nextTotal > WIDGET_RESPONSE_BYTES_LIMIT) throw new Error("Widget source exceeds the response size limit.");
      if (nextTotal > bytes.byteLength) {
        let capacity = Math.max(bytes.byteLength, 1024);
        while (capacity < nextTotal) capacity = Math.min(capacity * 2, WIDGET_RESPONSE_BYTES_LIMIT);
        const expanded = new Uint8Array(capacity);
        expanded.set(bytes.subarray(0, total));
        bytes = expanded;
      }
      bytes.set(value, total);
      total = nextTotal;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  signal.throwIfAborted();
  if (!isCurrent()) throw new Error("The viewer authority changed during a widget read.");
  return new Response(bytes.buffer.slice(0, total), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function audienceWidgetDataLoader(
  state: CompositionState,
  projection: CompositionMapProjectionOptions | undefined,
  options: ReadOnlyCompositionViewOptions,
  signal: AbortSignal,
): WidgetDataLoader {
  const catalog = projection?.catalog ?? [];
  const baseUrl = projection?.baseUrl ?? options.sourceAuthBaseUrl ?? "/api";
  const sourceAuthBaseUrl = options.sourceAuthBaseUrl ?? baseUrl;
  const documentUrl = options.documentUrl ?? options.widgetContainer.ownerDocument.baseURI;
  const approved = new Map<string, string>();
  for (const sourceId of new Set(
    [...state.widgets, ...state.controls].map((entry) => entry.sourceId).filter((id): id is string => !!id),
  )) {
    const resolvedSourceId = compositionDataSource(state, sourceId);
    if (!resolvedSourceId) continue;
    // The authored resolver has legacy fallbacks. A published widget/control may only
    // resolve a current-reader descriptor or one unique legacy service alias.
    if (!findCompositionSourceDescriptor(resolvedSourceId, catalog)) continue;
    const resolution = resolveCompositionSource(
      { id: sourceId, sourceId: resolvedSourceId, visible: true },
      { catalog, baseUrl, featureLimit: WIDGET_FEATURE_LIMIT },
    );
    if (
      !isCompositionSourceResolution(resolution) ||
      resolution.source.type !== "geojson" ||
      typeof resolution.source.data !== "string"
    )
      continue;
    const target = trustedSourceUrl(
      resolution.source.data,
      sourceAuthBaseUrl,
      documentUrl,
      options.sourceCatalogBaseUrl ?? projection?.baseUrl ?? "/api",
    );
    if (target) {
      approved.set(sourceId, target.href);
      approved.set(resolvedSourceId, target.href);
    }
  }
  const approvedUrls = new Set(approved.values());

  // The catalog loader resolves the same route as the map. Its only network seam
  // is this exact-URL host transport; no global fetch, bearer, or external URL is used.
  // Construct it only after an approved source asks for rows: denied metadata
  // must never resolve a session or invoke even a read transport.
  let loader: WidgetDataLoader | undefined;
  let activeSession: AudienceFeatureTransport | undefined;
  let initialized = false;
  let noTokenAuth: { getAccessToken: () => Promise<undefined> } | undefined;
  const tokenlessSession = () => {
    const session = options.getAudienceTransport();
    if (!initialized || session !== activeSession) {
      initialized = true;
      activeSession = session;
      noTokenAuth = session ? { getAccessToken: async () => undefined } : undefined;
    }
    return noTokenAuth;
  };
  return async (sourceId) => {
    signal.throwIfAborted();
    if (!approved.has(sourceId))
      return { ok: false, reason: `Source "${sourceId}" is not in the current-reader catalog.` };
    loader ??= createCatalogWidgetDataLoader({
      catalog,
      baseUrl,
      featureLimit: WIDGET_FEATURE_LIMIT,
      sourceAuthBaseUrl,
      sourceCatalogBaseUrl: options.sourceCatalogBaseUrl,
      documentUrl,
      getAuth: tokenlessSession,
      fetchImpl: async (input, init) => {
        if (typeof input !== "string" || (init?.method ?? "GET").toUpperCase() !== "GET")
          throw new Error("Published widgets require a bounded feature GET.");
        const url = new URL(input, documentUrl).href;
        if (!approvedUrls.has(url)) throw new Error("Widget source is outside the current-reader catalog.");
        const session = options.getAudienceTransport();
        if (!session?.fetchRequest) throw new Error("Current-reader widget transport is unavailable.");
        const response = await session.fetchRequest(url, {
          method: "GET",
          headers: { Accept: "application/geo+json, application/json" },
          signal: init?.signal,
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
        });
        if (session !== options.getAudienceTransport()) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error("The viewer authority changed during a widget read.");
        }
        if (response.redirected) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error("Widget source redirects are not allowed.");
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return response;
        }
        const bounded = await boundedWidgetResponse(
          response,
          init?.signal ?? new AbortController().signal,
          () => session === options.getAudienceTransport(),
        );
        if (session !== options.getAudienceTransport())
          throw new Error("The viewer authority changed during a widget read.");
        return bounded;
      },
    });
    const resolvedSourceId = compositionDataSource(state, sourceId);
    if (!resolvedSourceId) return { ok: false, reason: `Source "${sourceId}" is unresolved or ambiguous.` };
    const result = await loader(resolvedSourceId, { signal });
    if (result.ok && result.rows.length > WIDGET_FEATURE_LIMIT)
      return { ok: false, reason: `Source "${sourceId}" exceeded the ${WIDGET_FEATURE_LIMIT}-feature widget limit.` };
    return result;
  };
}

/** Mounts audience exploration controls and widgets; no editor or writer elements are registered. */
export function createReadOnlyCompositionView(options: ReadOnlyCompositionViewOptions): ReadOnlyCompositionView {
  let generation = 0;
  let disposed = false;
  let current:
    | {
        canvas: ReadOnlyMapCanvas;
        deck: HonuaStudioWidgetDeckElement;
        controls?: HonuaStudioControlBarElement;
        runtime?: StudioInteractionRuntime;
        reads: AbortController;
      }
    | undefined;
  let failure: string | undefined;
  let pending: Promise<void> = Promise.resolve();
  let activeTransport: AudienceFeatureTransport | undefined;
  let tokenlessMapAuth: Pick<AuthSession, "getAccessToken" | "fetchRequest"> | undefined;
  const getMapAuth = () => {
    const transport = options.getAudienceTransport();
    if (!tokenlessMapAuth || transport !== activeTransport) {
      activeTransport = transport;
      // Keep the protocol installed even without a host transport. Otherwise
      // its fetch fallback could issue a global, unauthorised source request.
      tokenlessMapAuth = {
        getAccessToken: async () => undefined,
        fetchRequest: async (input: RequestInfo | URL, init?: RequestInit) => {
          if (!transport?.fetchRequest || transport !== options.getAudienceTransport())
            throw new Error("Current-reader map transport is unavailable.");
          return transport.fetchRequest(input, init);
        },
      };
    }
    return tokenlessMapAuth;
  };
  const notify = () => {
    if (!disposed) options.onChange?.(view);
  };
  const clear = () => {
    current?.reads.abort();
    current?.runtime?.dispose();
    current?.controls?.remove();
    if (current?.controls) {
      current.controls.composition = undefined;
      current.controls.interactions = undefined;
      current.controls.dataLoader = undefined;
    }
    current?.canvas.dispose();
    current?.deck.remove();
    if (current?.deck) {
      current.deck.composition = undefined;
      current.deck.dataLoader = undefined;
    }
    current = undefined;
  };
  const view: ReadOnlyCompositionView = Object.freeze({
    get status() {
      return failure ? "unavailable" : (current?.canvas.status ?? "idle");
    },
    get statusDetail() {
      return failure ?? current?.canvas.statusDetail;
    },
    get projection() {
      return current?.canvas.projection;
    },
    get renderedFeatureCount() {
      return current?.canvas.renderedFeatureCount ?? 0;
    },
    reload(document: ReadOnlyCompositionDocument) {
      if (disposed) return Promise.reject(new Error("The published view was disposed."));
      const selected = ++generation;
      const work = (async () => {
        clear();
        failure = undefined;
        let candidateDeck: HonuaStudioWidgetDeckElement | undefined;
        let candidateCanvas: ReadOnlyMapCanvas | undefined;
        let candidateControls: HonuaStudioControlBarElement | undefined;
        let candidateRuntime: StudioInteractionRuntime | undefined;
        const reads = new AbortController();
        try {
          // The durable body and catalog are snapshots. Only this controller
          // changes after a local TOC, compare, or time interaction.
          const state = readCompositionBody(structuredClone(document.body));
          const projection = document.projection ? structuredClone(document.projection) : undefined;
          const controller = new CompositionController(state);
          registerWidgetDeck(options.widgetContainer, state.controls.length > 0);
          candidateDeck = options.widgetContainer.ownerDocument.createElement(
            WIDGET_TAG,
          ) as HonuaStudioWidgetDeckElement;
          if (!(candidateDeck instanceof HonuaStudioWidgetDeckElement))
            throw new Error("The published widget element is incompatible with this viewer.");
          const deck = candidateDeck;
          deck.dataLoader = audienceWidgetDataLoader(state, projection, options, reads.signal);
          deck.sourceCatalog = projection?.catalog;
          deck.sourceBaseUrl = projection?.baseUrl ?? options.sourceAuthBaseUrl ?? "/api";
          deck.sourceAuthBaseUrl = options.sourceAuthBaseUrl;
          deck.sourceCatalogBaseUrl = options.sourceCatalogBaseUrl;
          deck.onSelection = (targets) => controller.select(targets);
          // No editor command dispatcher: intrinsic controls apply privately.
          const started = startReadOnlyMapCanvasForController({
            container: options.container,
            controller,
            projection,
            getAuth: getMapAuth,
            sourceAuthBaseUrl: options.sourceAuthBaseUrl,
            sourceCatalogBaseUrl: options.sourceCatalogBaseUrl,
            mapFactory: options.mapFactory,
            styleProvider: options.styleProvider,
            onSelection: (targets) => controller.select(targets),
            onChange: (canvas) => {
              if (disposed || selected !== generation) return;
              if (current?.deck)
                current.deck.unrenderableLayers = (canvas.projection?.unresolved ?? []).map(({ layerId, reason }) => ({
                  layerId,
                  reason,
                }));
              notify();
            },
          });
          candidateCanvas = started.canvas;
          if (state.controls.length > 0) {
            candidateControls = options.widgetContainer.ownerDocument.createElement(
              CONTROL_TAG,
            ) as HonuaStudioControlBarElement;
            if (!(candidateControls instanceof HonuaStudioControlBarElement))
              throw new Error("The published control element is incompatible with this viewer.");
            candidateControls.dataLoader = deck.dataLoader;
            candidateControls.composition = controller;
          }
          const controls = candidateControls;
          if (state.controls.length > 0 || state.interactions.length > 0) {
            candidateRuntime = new StudioInteractionRuntime({
              controller,
              onAppearanceChange: (appearance) => {
                if (disposed || selected !== generation) return;
                started.setAppearance(appearance);
                deck.sourceFilters = appearance.sourceFilters ?? {};
                controls?.refreshCamera();
              },
            });
            if (controls) controls.interactions = candidateRuntime;
            started.setAppearance(candidateRuntime.appearance);
            deck.sourceFilters = candidateRuntime.appearance.sourceFilters ?? {};
          }
          // If appending the deck throws, the map's ready promise still needs
          // a rejection observer after we dispose its canvas.
          void started.ready.catch(() => {});
          // Creating the element or starting the map can synchronously trigger
          // a host reload. Never install that superseded candidate over the
          // newer view, even though its own ready promise has not settled yet.
          if (disposed || selected !== generation) {
            reads.abort();
            candidateRuntime?.dispose();
            candidateControls?.remove();
            candidateCanvas.dispose();
            candidateDeck.remove();
            candidateDeck.composition = undefined;
            candidateDeck.dataLoader = undefined;
            return;
          }
          current = { canvas: started.canvas, deck, controls, runtime: candidateRuntime, reads };
          candidateRuntime = undefined;
          candidateControls = undefined;
          candidateDeck = undefined;
          candidateCanvas = undefined;
          if (controls) options.widgetContainer.appendChild(controls);
          if (disposed || selected !== generation) return;
          options.widgetContainer.appendChild(deck);
          // A custom element's connected callback can also reenter reload.
          // That reload clears this installed candidate before installing its own.
          if (disposed || selected !== generation) return;
          deck.composition = controller;
          notify();
          await started.ready;
          if (disposed || selected !== generation) return;
          deck.unrenderableLayers = (started.canvas.projection?.unresolved ?? []).map(({ layerId, reason }) => ({
            layerId,
            reason,
          }));
          notify();
        } catch (error) {
          reads.abort();
          candidateRuntime?.dispose();
          candidateControls?.remove();
          candidateCanvas?.dispose();
          candidateDeck?.remove();
          if (candidateDeck) {
            candidateDeck.composition = undefined;
            candidateDeck.dataLoader = undefined;
          }
          if (!disposed && selected === generation && !failure) {
            failure = error instanceof Error ? error.message : String(error);
            clear();
            notify();
          }
          throw error;
        }
      })();
      if (!disposed && selected === generation) pending = work;
      return work;
    },
    settled() {
      return pending.then(() => current?.canvas.settled());
    },
    resize() {
      current?.canvas.resize();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      clear();
    },
  });
  pending = view.reload({ body: options.body, projection: options.projection });
  void pending.catch(() => {});
  return view;
}
