import type { CompositionState } from "../composition/model.js";
import { toCompositionDraftBody } from "../mcp/composition-envelope.js";
import { toCompositionDraft } from "./composition-draft-store.js";
import type { StudioLifecycleClient } from "./lifecycle-client.js";
import type { StudioPackageDraft } from "./lifecycle-types.js";

/** Human-authorized REST edits of the same durable draft used by the native agent.
 * No MCP replay, implicit conflict retry, publication or model history is involved. */
export class WorkspaceDraftBinding {
  #draft: StudioPackageDraft | undefined;
  public constructor(private client: Pick<StudioLifecycleClient, "getDraft" | "replaceDraft">) {}

  /** Renew transport credentials without changing the observed draft identity. */
  public rebind(client: Pick<StudioLifecycleClient, "getDraft" | "replaceDraft">): void {
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

  public async replace(state: CompositionState): Promise<CompositionState> {
    const current = this.#draft;
    if (!current) throw new Error("Attach an authorized workspace draft before editing.");
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
