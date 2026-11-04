import { verifiedSourcePathBase } from "../auth/host-session.js";
import { type CatalogDataset, StudioClient } from "../client/studio-client.js";
import type { ExploreDatasetMetadata } from "../recipes/explore-dataset.js";
import { runtimeMcpBaseUrl, runtimeServerBaseUrl } from "../runtime-config.js";
import type { AuthoritativeStyleProvider } from "../styles/authoritative-style-provider.js";
import { createCatalogWidgetDataLoader } from "../widgets/widget-data.js";
import { recipeSourceIdentity } from "./recipe-source-identity.js";
import type { SourceCatalog } from "./source-catalog.js";
import type { EpochToken, StalenessEpoch } from "./staleness-epoch.js";
import { WORKSPACE_AUTHORITY_CHANGED, type WorkspaceAuthority } from "./workspace-authority.js";

/** The public `<honua-studio-app>` methods recipe discovery goes through; hosts and tests may wrap them. */
export interface RecipeSourcesHost {
  listRecipeSources(signal: AbortSignal): Promise<readonly CatalogDataset[]>;
  createWorkspaceStyleProvider(options: {
    readonly getAuthority?: () => unknown;
    readonly signal?: AbortSignal;
  }): AuthoritativeStyleProvider;
}

export interface RecipeSourceChoicesOptions {
  readonly host: RecipeSourcesHost;
  readonly authority: WorkspaceAuthority;
  readonly catalog: SourceCatalog;
  readonly recipeAuthority: StalenessEpoch;
}

interface Resolution {
  readonly sourceId: string;
  readonly signal: AbortSignal;
  readonly generation: EpochToken;
}

const CHOICES_CHANGED = "The source choices changed. Refresh the recipe sources.";
const HOST_CHOICES_CHANGED = "The host source choices changed. Refresh the recipe sources.";

/**
 * The authorized sources a recipe may start from. A choice made from an earlier listing is revalidated
 * against a fresh one before its metadata is read.
 */
export class RecipeSourceChoices {
  #choices: readonly CatalogDataset[] | undefined;
  #previousChoices: readonly CatalogDataset[] | undefined;
  #choicesAuthority: EpochToken | undefined;

  constructor(private readonly options: RecipeSourceChoicesOptions) {}

  /** A different catalog keeps the current choices only as the reference for revalidating a selection. */
  rotate(): void {
    if (this.#choices) this.#previousChoices = this.#choices;
    this.#choicesAuthority = undefined;
    this.#choices = undefined;
  }

  /** Requires the next selection to re-list its sources. */
  invalidate(): void {
    this.#choicesAuthority = undefined;
  }

  clear(): void {
    this.#choicesAuthority = undefined;
    this.#choices = undefined;
    this.#previousChoices = undefined;
  }

  async list(signal: AbortSignal): Promise<readonly CatalogDataset[]> {
    const { authority, catalog, recipeAuthority } = this.options;
    const generation = recipeAuthority.current;
    const lease = authority.lease.current;
    this.#choicesAuthority = undefined;
    this.#choices = undefined;
    const hostOwnsCatalog = catalog.fromHost;
    const hostCatalog = catalog.catalog;
    const auth = authority.auth;
    const client = new StudioClient(
      runtimeServerBaseUrl(),
      {
        getAccessToken: (options) => auth.getAccessToken(options),
        fetchRequest: (input, init) => (auth.fetchRequest ?? fetch)(input, { ...init, signal }),
      },
      runtimeMcpBaseUrl(),
    );
    const published = await client.listCatalog();
    signal.throwIfAborted();
    if (!recipeAuthority.isCurrent(generation) || auth !== authority.auth || !authority.lease.isCurrent(lease))
      throw new Error(WORKSPACE_AUTHORITY_CHANGED);
    let choices: readonly CatalogDataset[] = published;
    if (hostOwnsCatalog) {
      if (!catalog.fromHost || hostCatalog !== catalog.catalog) throw new Error(HOST_CHOICES_CHANGED);
      choices = this.#hostChoicesAgreeingWith(hostCatalog ?? [], published);
    } else {
      if (catalog.fromHost) throw new Error(HOST_CHOICES_CHANGED);
      catalog.apply(published);
    }
    this.#choices = structuredClone(choices);
    this.#choicesAuthority = generation;
    return structuredClone(choices);
  }

  async resolve(sourceId: string, signal: AbortSignal): Promise<ExploreDatasetMetadata> {
    const resolution: Resolution = { sourceId, signal, generation: this.options.recipeAuthority.current };
    await this.#revalidateStaleSelection(resolution);
    const choices = this.#choices;
    const source = this.#selectableSource(resolution);
    const requireSameChoices = () => {
      if (choices !== this.#choices) throw new Error(CHOICES_CHANGED);
    };
    if (source.protocol !== "geoservices-feature-service")
      throw new Error("Choose a published Honua vector FeatureServer source.");
    const provider = this.options.host.createWorkspaceStyleProvider({
      signal,
      getAuthority: () => this.options.recipeAuthority.current,
    });
    const descriptor = await provider.describeDataset(source);
    requireSameChoices();
    const bounds = await provider.describeSourceBounds(source);
    requireSameChoices();
    const type = descriptor.geometryType.toLowerCase();
    if (type.includes("raster") || type.includes("image"))
      throw new Error("Choose a point, line or polygon vector source.");
    const result = await this.#readSampleRows(resolution, source, provider.serverRoot);
    requireSameChoices();
    if (!result.ok) throw new Error(`Readable feature queries are required. ${result.reason}`);
    return {
      source: { ...source, geometryType: descriptor.geometryType },
      fields: descriptor.fields,
      rows: result.rows,
      truncated: result.truncated,
      ...(bounds ? { bounds } : {}),
    };
  }

  #identity(source: CatalogDataset): string | undefined {
    const { session } = this.options.authority;
    return recipeSourceIdentity(
      source,
      session && "kind" in session && session.kind === "cookie"
        ? verifiedSourcePathBase(session.sourcePathBase)
        : undefined,
    );
  }

  #hostChoicesAgreeingWith(
    hostCatalog: readonly CatalogDataset[],
    published: readonly CatalogDataset[],
  ): readonly CatalogDataset[] {
    return hostCatalog.filter((source) => {
      const observed = published.find((entry) => entry.id === source.id);
      if (!observed) return false;
      const identity = this.#identity(source);
      if (!identity || identity !== this.#identity(observed))
        throw new Error(
          `Host source "${source.id}" disagrees with the authorized published locator. Refresh the host source choices.`,
        );
      return true;
    });
  }

  /** A selection from an older listing re-lists the sources and must still name the same published source. */
  async #revalidateStaleSelection({ sourceId, signal, generation }: Resolution): Promise<void> {
    const selected = this.#choices?.find((entry) => entry.id === sourceId);
    const current = this.options.catalog.find(sourceId);
    const remembered = selected ?? this.#previousChoices?.find((entry) => entry.id === sourceId);
    if ((selected && current && this.#choicesAuthority === generation) || !remembered) return;
    const previous = structuredClone(remembered);
    await this.options.host.listRecipeSources(signal);
    const refreshed = this.#choices?.find((entry) => entry.id === sourceId);
    if (
      !refreshed ||
      this.#identity(previous) !== this.#identity(refreshed) ||
      previous.geometryType !== refreshed.geometryType
    ) {
      this.clear();
      throw new Error("The authorized source changed. Refresh the dataset choices before selecting a source.");
    }
  }

  #selectableSource({ sourceId, generation }: Resolution): CatalogDataset {
    const selected = this.#choices?.find((entry) => entry.id === sourceId);
    const current = this.options.catalog.find(sourceId);
    const source = selected && structuredClone(selected);
    if (
      !source ||
      !current ||
      this.#identity(current) !== this.#identity(source) ||
      this.#choicesAuthority !== generation
    )
      throw new Error("Refresh the authorized dataset choices before selecting a source.");
    return source;
  }

  async #readSampleRows(
    { sourceId, signal, generation }: Resolution,
    source: CatalogDataset,
    sourceAuthBaseUrl: string,
  ) {
    const { authority, recipeAuthority } = this.options;
    const auth = authority.auth;
    const result = await createCatalogWidgetDataLoader({
      catalog: [source],
      baseUrl: runtimeMcpBaseUrl(),
      sourceAuthBaseUrl,
      sourceCatalogBaseUrl: runtimeMcpBaseUrl(),
      documentUrl: document.baseURI,
      featureLimit: 100,
      getAuth: () => {
        recipeAuthority.assertCurrent(generation, WORKSPACE_AUTHORITY_CHANGED);
        return authority.auth;
      },
      fetchImpl: (input, init) => (auth.fetchRequest ?? fetch)(input, { ...init, signal }),
    })(sourceId, { signal });
    signal.throwIfAborted();
    recipeAuthority.assertCurrent(generation, WORKSPACE_AUTHORITY_CHANGED);
    return result;
  }
}
