import type { CatalogDataset } from "../client/studio-client.js";
import { StudioClient } from "../client/studio-client.js";
import { canonicalCompositionJson } from "../composition/model.js";
import { runtimeMcpBaseUrl, runtimeServerBaseUrl } from "../runtime-config.js";
import { sourceStyleProvider } from "./runtime-clients.js";
import type { EpochToken } from "./staleness-epoch.js";
import { WORKSPACE_AUTHORITY_CHANGED, type WorkspaceAuthority } from "./workspace-authority.js";

export interface SourceCatalogHooks {
  readonly isConnected: () => boolean;
  /** Runs before a different catalog replaces the current one. */
  readonly onCatalogReplacing: () => void;
  readonly onCatalogApplied: (catalog: readonly CatalogDataset[] | undefined) => void;
  /** Runs when a same-principal session keeps the catalog but must re-check it. */
  readonly onRevalidate: () => void;
}

export type ProcessSourceChoice = { readonly id: string; readonly title: string };

/**
 * The published source catalog the map resolves layers against. Fetched once per authority unless a host
 * assigns its own listing, which no fetch then overwrites.
 */
export class SourceCatalog {
  #catalog: readonly CatalogDataset[] | undefined;
  #requested = false;
  #fromHost = false;
  #processSourceAuthority: EpochToken | undefined;

  constructor(
    private readonly authority: WorkspaceAuthority,
    private readonly hooks: SourceCatalogHooks,
  ) {}

  get catalog(): readonly CatalogDataset[] | undefined {
    return this.#catalog;
  }

  get fromHost(): boolean {
    return this.#fromHost;
  }

  find(sourceId: string): CatalogDataset | undefined {
    return this.#catalog?.find((entry) => entry.id === sourceId);
  }

  /** A host-assigned catalog is never refetched; lease renewal keeps it and a new authority must replace it. */
  claimForHost(): void {
    this.#fromHost = true;
    this.#requested = true;
  }

  apply(catalog: readonly CatalogDataset[] | undefined): void {
    if (catalog !== this.#catalog) this.hooks.onCatalogReplacing();
    this.#catalog = catalog;
    this.hooks.onCatalogApplied(catalog);
  }

  /** Drops what the former authority could read. */
  forget(): void {
    this.#catalog = undefined;
    this.#processSourceAuthority = undefined;
    this.#requested = false;
  }

  /** Fetches the catalog once. Failure is silent: the canvas reports layers as not renderable instead. */
  async load(): Promise<void> {
    if (this.#catalog !== undefined) return;
    await this.#fetchOnce();
  }

  /**
   * Re-fetches after a session replacement or a status transition. Never call it per auth dispatch: every
   * `getAccessToken()` dispatches a state change, so refetching per dispatch would loop.
   */
  refresh(): void {
    if (this.#fromHost) return;
    this.#catalog = undefined;
    this.#requested = false;
    void this.load();
  }

  /** Re-reads the catalog for a renewed lease while keeping the current one visible. */
  revalidate(): void {
    if (this.#fromHost) return;
    this.hooks.onRevalidate();
    this.#requested = false;
    void this.#fetchOnce();
  }

  /** Actual published choices for the canonical GP layer picker; no map focus is inferred. */
  async listProcessSources(): Promise<readonly ProcessSourceChoice[]> {
    const { authority } = this;
    const generation = authority.epoch.current;
    const auth = authority.auth;
    const client = authority.studioClientOverridden
      ? authority.studioClient
      : new StudioClient(runtimeServerBaseUrl(), auth, runtimeMcpBaseUrl());
    const catalog = await client.listCatalog();
    if (!authority.epoch.isCurrent(generation) || auth !== authority.auth) throw new Error(WORKSPACE_AUTHORITY_CHANGED);
    this.apply(catalog);
    this.#processSourceAuthority = generation;
    return catalog
      .filter(
        (source) => typeof source.locator?.serviceId === "string" && Number.isSafeInteger(source.locator?.layerId),
      )
      .map((source) => ({ id: source.id, title: source.title ?? source.id }));
  }

  async resolveProcessSource(sourceId: string): Promise<{ processLayerId?: number; unavailableReason?: string }> {
    const { authority } = this;
    const generation = authority.epoch.current;
    const source = this.find(sourceId);
    if (!source || this.#processSourceAuthority !== generation)
      throw new Error("Refresh the authorized source choices before selecting a process layer.");
    const provider = sourceStyleProvider({
      baseUrl: authority.sourceBaseUrl,
      getAuth: () => authority.auth,
      signal: AbortSignal.timeout(8000),
    });
    const result = await provider.resolveProcessSource(source);
    authority.epoch.assertCurrent(generation, WORKSPACE_AUTHORITY_CHANGED);
    return result;
  }

  async #fetchOnce(): Promise<void> {
    if (this.#requested) return;
    // Never fetch while signed out: a second 401 marks the session expired, which would show a
    // never-signed-in shell as "Session expired". The auth status listener retries once signed in.
    const { authority } = this;
    const status = authority.auth.getState().status;
    if (status !== "fresh" && status !== "refreshing") return;
    this.#requested = true;
    try {
      const generation = authority.epoch.current;
      const auth = authority.auth;
      const previousCatalog = this.#catalog;
      const catalog = await authority.studioClient.listCatalog();
      if (
        !this.hooks.isConnected() ||
        !authority.epoch.isCurrent(generation) ||
        auth !== authority.auth ||
        this.#catalog !== previousCatalog
      )
        return;
      if (previousCatalog && canonicalCompositionJson(previousCatalog) === canonicalCompositionJson(catalog)) return;
      this.apply(catalog);
    } catch {
      // An unreachable catalog degrades the map; it must not break the shell.
    }
  }
}
