import { type HonuaMapPackage, composeStyle } from "@honua/sdk-js/runtime";
import type { HonuaStyleSpecification } from "@honua/sdk-js/style";
import type { AuthSession } from "../auth/types.js";
import type { CatalogDataset } from "../client/studio-client.js";
import { trustedSourceUrl } from "../map/authenticated-source-protocol.js";
import {
  type CompositionMapFactory,
  type CompositionMapLike,
  defaultCompositionMapFactory,
} from "../map/composition-map-view.js";
import { compositionToMapPackage } from "../map/map-package-projection.js";
import { isCompositionSourceResolution, resolveCompositionSource } from "../map/source-resolution.js";
import type { StudioCompositionBodyWire } from "../mcp/studio-tools.js";
import { applyStudioDraftBody } from "../mcp/tool-bridge.js";
import type { AuthoritativeStyleProvider } from "./authoritative-style-provider.js";
import { type MapStyleDocument, validateMapStyleEdit } from "./map-style-edit.js";
import type { SharedStyleMapConsumer } from "./shared-style-consumer.js";
import { canonicalStyleRefBody } from "./style-ref-body.js";

export interface SharedStylePreviewOptions {
  readonly container: HTMLElement;
  readonly consumer:
    | SharedStyleMapConsumer
    | { readonly kind: "source"; readonly source: CatalogDataset; readonly catalogSourceId: string };
  readonly catalog?: readonly CatalogDataset[];
  readonly styleId: string;
  readonly document: MapStyleDocument;
  readonly getAuth: () => AuthSession | undefined;
  /** Stable host binding (principal/environment/path/workspace); lease renewal must preserve it. */
  readonly getAuthority?: () => unknown;
  readonly sourceBaseUrl: string;
  readonly legacySourceBaseUrl?: string;
  readonly documentUrl: string;
  readonly styleProvider: Pick<AuthoritativeStyleProvider, "read" | "describeSource">;
  readonly mapFactory?: CompositionMapFactory;
  readonly onStatus?: (status: { readonly ready: boolean; readonly message?: string }) => void;
}

/** A derived renderer only. It never selects a task, changes a lifecycle draft, or saves catalog data. */
export function createSharedStylePreview(options: SharedStylePreviewOptions) {
  const consumer = structuredClone(options.consumer);
  let baseline = structuredClone(options.document);
  let epoch = 0;
  let disposed = false;
  let map: CompositionMapLike | undefined;
  let queue = Promise.resolve();
  const getAuthority = options.getAuthority ?? options.getAuth;
  const authority = getAuthority();
  const current = (revision: number) => !disposed && revision === epoch && getAuthority() === authority;
  const sources = consumer.kind === "source" ? [consumer.source] : [...(options.catalog ?? [])];

  async function project(candidate: MapStyleDocument): Promise<HonuaStyleSpecification> {
    const errors = validateMapStyleEdit(baseline, candidate);
    if (errors.length) throw new Error(errors[0]);
    let pkg: HonuaMapPackage;
    if (consumer.kind === "source") {
      const selected = consumer.catalogSourceId;
      const style = structuredClone(candidate) as unknown as HonuaStyleSpecification;
      if (!style.sources[selected]) throw new Error("Select an actual catalog style source for preview.");
      const resolved = resolveCompositionSource(
        { id: consumer.source.id, sourceId: consumer.source.id, visible: true },
        { catalog: [consumer.source], baseUrl: options.sourceBaseUrl },
      );
      if (!isCompositionSourceResolution(resolved)) throw new Error(resolved.reason);
      // Only the explicitly selected catalog source receives the authorized human source.
      // Other source data must never be fetched or presented as an inferred selection.
      style.sources = { [selected]: resolved.source as HonuaStyleSpecification["sources"][string] };
      style.layers = style.layers.filter((layer) => layer.source === selected || layer.type === "background");
      pkg = {
        format: "honua_map_package.v1",
        mapPackageId: "shared-style-readonly-preview",
        mapSpec: style,
        sourceBindings: [],
      };
    } else {
      const body = consumer.envelope.body;
      if (!body || typeof body !== "object") throw new Error("The selected map consumer has no map body.");
      if (Array.isArray((body as { layers?: unknown }).layers)) {
        const state = applyStudioDraftBody(body as StudioCompositionBodyWire);
        const projection = compositionToMapPackage(state, { catalog: sources, baseUrl: options.sourceBaseUrl });
        if (projection.unresolved.length) throw new Error(projection.unresolved[0]!.reason);
        pkg = projection.mapPackage;
      } else if ((body as { format?: unknown }).format === "honua_map_package.v1")
        pkg = structuredClone(body) as HonuaMapPackage;
      else throw new Error("The selected map consumer is not a supported canonical map package.");
      if (!pkg.styleRefs?.some((reference) => reference.styleId === options.styleId && !reference.body))
        throw new Error("The selected map has no live reference to this shared style.");
      pkg = {
        ...pkg,
        styleRefs: await Promise.all(
          (pkg.styleRefs ?? []).map(async (reference) => {
            if (reference.body) return reference;
            const document =
              reference.styleId === options.styleId
                ? candidate
                : (JSON.parse((await options.styleProvider.read(reference.styleId)).inlineBody) as MapStyleDocument);
            const bindings = (
              reference as { layerBindings?: import("./map-style-edit.js").CompositionStyleLayerBinding[] }
            ).layerBindings;
            if (reference.styleId === options.styleId && !bindings)
              throw new Error("This map needs canonical shared-style bindings before visual preview.");
            return {
              ...reference,
              body: canonicalStyleRefBody(document as unknown as HonuaStyleSpecification, bindings),
            };
          }),
        ),
      };
    }
    const style = await composeStyle(pkg, pkg.mapSpec, {});
    if (style.sprite || style.glyphs || style.imports) throw new Error("External preview assets are not supported.");
    for (const source of Object.values(style.sources)) {
      if (
        source.type !== "geojson" ||
        (source as Record<string, unknown>).url ||
        (source as Record<string, unknown>).tiles
      )
        throw new Error("Preview requires authorized feature sources.");
      if (
        typeof source.data === "string" &&
        !trustedSourceUrl(source.data, options.sourceBaseUrl, options.documentUrl, options.legacySourceBaseUrl)
      )
        throw new Error("Preview source is outside the authorized deployment.");
    }
    return style;
  }

  function preview(candidate?: MapStyleDocument): Promise<void> {
    const revision = ++epoch;
    const document = structuredClone(candidate ?? baseline);
    const operation = queue
      .catch(() => {})
      .then(async () => {
        if (!current(revision)) return;
        try {
          const style = await project(document);
          if (!current(revision)) return;
          if (!map) {
            const created = await (options.mapFactory ?? defaultCompositionMapFactory)({
              container: options.container,
              style,
              center: [0, 20],
              zoom: 1,
              attributionText: "Honua · shared-style preview",
              getAuth: () => {
                if (disposed || getAuthority() !== authority) throw new Error("The preview authority changed.");
                return options.getAuth();
              },
              sourceBaseUrl: options.sourceBaseUrl,
              legacySourceBaseUrl: options.legacySourceBaseUrl,
              onSourceError: (error) => {
                if (!disposed && getAuthority() === authority)
                  options.onStatus?.({ ready: false, message: error.message });
              },
              onSourceIncomplete: (message) => {
                if (!disposed && getAuthority() === authority) options.onStatus?.({ ready: true, message });
              },
            });
            if (!current(revision)) {
              created.remove();
              return;
            }
            map = created;
          } else map.setStyle(style, { diff: true });
          options.onStatus?.({
            ready: true,
            ...(consumer.kind === "source"
              ? { message: "Previewing only the explicitly selected authorized source." }
              : {}),
          });
        } catch (error) {
          if (!current(revision)) return;
          options.onStatus?.({ ready: false, message: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      });
    queue = operation;
    return operation;
  }
  return Object.freeze({
    get layers() {
      return (Array.isArray(baseline.layers) ? (baseline.layers as Record<string, unknown>[]) : [])
        .filter((layer) => typeof layer.id === "string" && typeof layer.source === "string")
        .map((layer) => ({ id: layer.id as string, sourceId: layer.source as string, title: layer.id as string }));
    },
    preview,
    observeSavedDocument(document: MapStyleDocument) {
      baseline = structuredClone(document);
      return preview();
    },
    async getFields(catalogSourceId: string) {
      if (disposed || getAuthority() !== authority) throw new Error("The preview authority changed.");
      let selected: CatalogDataset | undefined;
      if (consumer.kind === "source") {
        if (catalogSourceId === consumer.catalogSourceId) selected = consumer.source;
      } else {
        const body = consumer.envelope.body as {
          mapSpec?: HonuaStyleSpecification;
          styleRefs?: readonly {
            styleId: string;
            body?: unknown;
            layerBindings?: readonly { styleLayerId: string; targetLayerId: string }[];
          }[];
        };
        const catalogLayers = Array.isArray(baseline.layers)
          ? (baseline.layers as { id: string; source?: string }[])
          : [];
        const matching = new Set(
          catalogLayers.filter((layer) => layer.source === catalogSourceId).map((layer) => layer.id),
        );
        const targets =
          body.styleRefs
            ?.filter((ref) => ref.styleId === options.styleId && !ref.body)
            .flatMap((ref) => ref.layerBindings ?? [])
            .filter((binding) => matching.has(binding.styleLayerId))
            .map((binding) => binding.targetLayerId) ?? [];
        const sourceIds = new Set(
          body.mapSpec?.layers
            .filter((layer) => targets.includes(layer.id))
            .map((layer) => layer.source)
            .filter((id): id is string => typeof id === "string"),
        );
        if (sourceIds.size === 1) selected = sources.find((source) => sourceIds.has(source.id));
      }
      if (!selected) throw new Error("Select an unambiguous authorized source to inspect thematic fields.");
      const fields = await options.styleProvider.describeSource(selected);
      if (disposed || getAuthority() !== authority) throw new Error("The preview authority changed.");
      return fields;
    },
    dispose() {
      disposed = true;
      epoch++;
      map?.remove();
      map = undefined;
    },
  });
}
