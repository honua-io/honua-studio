import type { CompositionState } from "../composition/model.js";
import { toCompositionDraftBody } from "../mcp/composition-envelope.js";
import type { MapStyleDocument } from "../styles/map-style-edit.js";
import { toCompositionDraft } from "./composition-draft-store.js";
import type { StudioLifecycleClient } from "./lifecycle-client.js";
import type { StudioPackageDraft } from "./lifecycle-types.js";

type EditorDraftClient = Pick<StudioLifecycleClient, "getDraft" | "replaceDraft"> &
  Partial<Pick<StudioLifecycleClient, "setMapStyle" | "initializeDraftStyle">>;

/** Human-authorized REST edits of the same durable draft used by the native agent.
 * No MCP replay, implicit conflict retry, publication or model history is involved. */
export class EditorDraftBinding {
  #draft: StudioPackageDraft | undefined;
  public constructor(private client: EditorDraftClient) {}

  /** Renew transport credentials without changing the observed draft identity. */
  public rebind(client: EditorDraftClient): void {
    this.client = client;
  }

  public get identity(): { draftId: string; generation: number; packageKey: string } | undefined {
    return (
      this.#draft && {
        draftId: this.#draft.draftId,
        generation: this.#draft.generation,
        packageKey: this.#draft.packageKey,
      }
    );
  }

  public async observe(draftId: string): Promise<CompositionState> {
    const draft = await this.client.getDraft(draftId);
    const state = toCompositionDraft(draft).envelope.body;
    this.#draft = draft;
    return state;
  }

  /** Whether a refresh is this draft and newer than the token the editor holds. */
  public classifyObservation(draft: StudioPackageDraft): "foreign" | "stale" | "newer" {
    const current = this.#draft;
    if (!current) throw new Error("Attach an authorized editor draft before editing.");
    if (!isSameDraft(draft, current)) return "foreign";
    return draft.generation > current.generation ? "newer" : "stale";
  }

  /**
   * Saving a version stamps the draft and advances its generation without
   * returning that generation. Adopt a newer observation of this same draft.
   * The caller checks that the observation is still the editor's map.
   */
  public adoptIfNewer(draft: StudioPackageDraft): void {
    if (this.classifyObservation(draft) !== "newer") return;
    this.#draft = draft;
  }

  public async initializeStyle(mapSpec: MapStyleDocument): Promise<CompositionState> {
    const current = this.#draft;
    if (!current || !this.client.initializeDraftStyle)
      throw new Error("The canonical style initializer is unavailable.");
    return this.#acceptStyle(
      await this.client.initializeDraftStyle(current.draftId, current.generation, mapSpec),
      current,
    );
  }

  public async replaceStyle(mapSpec: MapStyleDocument): Promise<CompositionState> {
    const current = this.#draft;
    if (!current || !this.client.setMapStyle) throw new Error("The canonical style command is unavailable.");
    return this.#acceptStyle(await this.client.setMapStyle(current.draftId, current.generation, mapSpec), current);
  }

  #acceptStyle(draft: StudioPackageDraft, current: StudioPackageDraft): CompositionState {
    if (!isSameDraft(draft, current) || draft.generation <= current.generation)
      throw new Error("The style command did not return an accepted authoritative draft.");
    const observed = toCompositionDraft(draft).envelope.body;
    this.#draft = draft;
    return observed;
  }

  public async replace(state: CompositionState): Promise<CompositionState> {
    const current = this.#draft;
    if (!current) throw new Error("Attach an authorized editor draft before editing.");
    const draft = await this.client.replaceDraft(current.draftId, {
      packageKey: current.packageKey,
      generation: current.generation,
      ...(current.workspaceId !== undefined ? { workspaceId: current.workspaceId } : {}),
      ...(current.ownerId !== undefined ? { ownerId: current.ownerId } : {}),
      envelope: {
        ...current.envelope,
        body: toCompositionDraftBody(
          state,
          current.packageKey,
          current.envelope.family,
          current.envelope.body as Readonly<Record<string, unknown>>,
          current.envelope.format,
        ),
      },
    });
    const observed = toCompositionDraft(draft).envelope.body;
    this.#draft = draft;
    return { ...observed, pins: state.pins, annotations: state.annotations };
  }
}

function isSameDraft(draft: StudioPackageDraft | undefined, current: StudioPackageDraft): draft is StudioPackageDraft {
  return (
    draft?.draftId === current.draftId &&
    draft.packageKey === current.packageKey &&
    Number.isSafeInteger(draft.generation)
  );
}
