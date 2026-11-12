import type { CatalogDataset } from "../client/studio-client.js";
import { canonicalCompositionJson } from "../composition/model.js";
import type { StudioLifecycleClient } from "../lifecycle/lifecycle-client.js";
import type { StudioPackageDraftCreateRequest } from "../lifecycle/lifecycle-types.js";
import { MAP_COMPOSITION_ENVELOPE, toCompositionDraftBody } from "../mcp/composition-envelope.js";
import {
  type ExploreDatasetInput,
  type ExploreDatasetMetadata,
  compileExploreDataset,
} from "../recipes/explore-dataset.js";
import { RecipePanel } from "../recipes/recipe-panel.js";
import { RecipeSubmission } from "../recipes/recipe-submission.js";
import { RecipeSourceChoices, type RecipeSourcesHost } from "./recipe-source-choices.js";
import type { ShellChrome } from "./shell-chrome.js";
import type { SourceCatalog } from "./source-catalog.js";
import { type EpochToken, StalenessEpoch } from "./staleness-epoch.js";
import { EDITOR_AUTHORITY_CHANGED, type EditorAuthority } from "./workspace-authority.js";
import type { EditorDraftIdentity, EditorDraftSession } from "./workspace-draft-session.js";

/** The public `<honua-studio-app>` methods the recipe picker goes through; hosts and tests may wrap them. */
export interface RecipeHost extends RecipeSourcesHost {
  resolveRecipeSource(sourceId: string, signal: AbortSignal): Promise<ExploreDatasetMetadata>;
  createRecipeDraft(input: ExploreDatasetInput, submissionId: string): Promise<EditorDraftIdentity>;
  openRecipePicker(): void;
  closeRecipePicker(): void;
  prepareEditorTurn(): Promise<unknown>;
}

export interface RecipeControllerOptions {
  readonly host: RecipeHost;
  readonly authority: EditorAuthority;
  readonly catalog: SourceCatalog;
  readonly drafts: EditorDraftSession;
  readonly chrome: ShellChrome;
}

interface RecipeSubmissionEntry {
  readonly input: string;
  readonly generation: EpochToken;
  readonly submission: RecipeSubmission;
  originalDraftId?: string;
  originalDraftGeneration?: number;
  attachmentAllowed: boolean;
  metadataAbort?: AbortController;
  request?: StudioPackageDraftCreateRequest;
  pending?: Promise<EditorDraftIdentity>;
}

const TOGGLE = "recipe-toggle";
const REOPEN_IN_ORIGINAL_EDITOR = `${EDITOR_AUTHORITY_CHANGED} Reopen this draft in its original workspace.`;
const CANCELLED_BEFORE_SUBMISSION = "Recipe creation was cancelled before submission.";

function activeMapChanged(draftId: string): Error {
  return new Error(
    `Draft ${draftId} was created, but the active map changed. Open that draft explicitly to recover it.`,
  );
}

function frozenCopy(input: ExploreDatasetInput): ExploreDatasetInput {
  const copy = structuredClone(input);
  Object.freeze(copy.tableFields);
  return Object.freeze(copy);
}

/**
 * The "Start from a recipe" picker and its draft submissions. Viewing and choosing inputs never creates a
 * draft; a stable submission ID reuses the same canonical request and Idempotency-Key across retries.
 */
export class RecipeController {
  readonly #epoch = new StalenessEpoch();
  readonly #sources: RecipeSourceChoices;
  #revokedSubmissionIds = new Set<string>();
  #submissions = new Map<string, RecipeSubmissionEntry>();
  #panel: RecipePanel | undefined;
  #draftToAttach: string | undefined;

  constructor(private readonly options: RecipeControllerOptions) {
    this.#sources = new RecipeSourceChoices({
      host: options.host,
      authority: options.authority,
      catalog: options.catalog,
      recipeAuthority: this.#epoch,
    });
  }

  /** True while a created recipe draft is being attached, which must not dispose the picker. */
  isAttaching(draftId: string): boolean {
    return this.#draftToAttach === draftId;
  }

  open(): void {
    const outlet = this.options.chrome.recipeOutlet();
    if (!outlet) throw new Error("Connect the Studio element before opening recipes.");
    outlet.hidden = false;
    const { host } = this.options;
    this.#panel ??= new RecipePanel(outlet, {
      listSources: (signal) => host.listRecipeSources(signal),
      describeSource: (id, signal) => host.resolveRecipeSource(id, signal),
      create: (input, id) => host.createRecipeDraft(input, id),
      close: () => host.closeRecipePicker(),
      startAnother: () => {
        this.dispose();
        host.openRecipePicker();
      },
      canChangeInputs: (id) => !this.#submissions.get(id)?.submission.submitted,
    });
    this.options.chrome.markExpanded(TOGGLE);
    this.#panel.resume();
  }

  close(): void {
    this.#panel?.cancelDiscovery();
    for (const entry of this.#submissions.values())
      if (entry.pending) {
        entry.attachmentAllowed = false;
        entry.metadataAbort?.abort();
      }
    const outlet = this.options.chrome.recipeOutlet();
    if (outlet) outlet.hidden = true;
    this.options.chrome.markCollapsed(TOGGLE);
    this.options.chrome.focus(TOGGLE);
  }

  dispose(): void {
    this.#panel?.dispose();
    this.#panel = undefined;
    this.#sources.clear();
    this.options.host.closeRecipePicker();
  }

  /** Submissions started under a former authority can never be retried. */
  resetAuthority(): void {
    this.dispose();
    this.#epoch.next();
    for (const id of this.#submissions.keys()) this.#revokedSubmissionIds.add(id);
    this.#submissions.clear();
  }

  onCatalogReplaced(): void {
    this.#sources.rotate();
  }

  invalidateSourceChoices(): void {
    this.#sources.invalidate();
  }

  listSources(signal: AbortSignal): Promise<readonly CatalogDataset[]> {
    return this.#sources.list(signal);
  }

  resolveSource(sourceId: string, signal: AbortSignal): Promise<ExploreDatasetMetadata> {
    return this.#sources.resolve(sourceId, signal);
  }

  createDraft(requestedInput: ExploreDatasetInput, submissionId: string): Promise<EditorDraftIdentity> {
    const input = frozenCopy(requestedInput);
    if (!/^[A-Za-z0-9-]{1,100}$/.test(submissionId))
      return Promise.reject(new Error("A stable recipe submission ID is required."));
    if (this.#revokedSubmissionIds.has(submissionId))
      return Promise.reject(new Error("Retry this submission only in its original workspace authority."));
    const generation = this.#epoch.current;
    const json = canonicalCompositionJson(input);
    const existing = this.#submissions.get(submissionId);
    if (existing && (existing.input !== json || existing.generation !== generation))
      return Promise.reject(new Error("Retry this submission with its original inputs and workspace authority."));
    const entry = existing ?? this.#addSubmission(submissionId, json, generation);
    if (entry.pending) return entry.pending;
    entry.attachmentAllowed = true;
    entry.metadataAbort = new AbortController();
    const run = this.#submit(entry, input);
    entry.pending = run;
    void run
      .finally(() => {
        entry.pending = undefined;
      })
      .catch(() => undefined);
    return run;
  }

  #addSubmission(submissionId: string, input: string, generation: EpochToken): RecipeSubmissionEntry {
    const entry: RecipeSubmissionEntry = {
      input,
      generation,
      submission: new RecipeSubmission(),
      originalDraftId: this.options.drafts.identity?.draftId,
      attachmentAllowed: true,
    };
    this.#submissions.set(submissionId, entry);
    return entry;
  }

  async #submit(entry: RecipeSubmissionEntry, input: ExploreDatasetInput): Promise<EditorDraftIdentity> {
    await this.options.host.prepareEditorTurn();
    this.#epoch.assertCurrent(entry.generation, EDITOR_AUTHORITY_CHANGED);
    const client = this.options.authority.lifecycleClient();
    if (!entry.request) {
      const request = await this.#buildRequest(entry, input, client);
      this.#epoch.assertCurrent(entry.generation, EDITOR_AUTHORITY_CHANGED);
      entry.request = request;
    }
    if (!entry.attachmentAllowed && !entry.submission.submitted) throw new Error(CANCELLED_BEFORE_SUBMISSION);
    const created = await entry.submission.createDraft(entry.request, (request, commandId) =>
      client.createDraft(request, commandId),
    );
    this.#epoch.assertCurrent(entry.generation, REOPEN_IN_ORIGINAL_EDITOR);
    return this.#attachCreated(entry, created.draftId);
  }

  /** Captures the active map first, so a later map change can be told apart from this recipe's own draft. */
  async #buildRequest(
    entry: RecipeSubmissionEntry,
    input: ExploreDatasetInput,
    client: StudioLifecycleClient,
  ): Promise<StudioPackageDraftCreateRequest> {
    const { drafts, host } = this.options;
    entry.originalDraftId = drafts.identity?.draftId;
    entry.originalDraftGeneration = drafts.identity?.generation;
    const capabilities = await client.getPackageFamilies();
    const map = capabilities.families.find((family) => family.family === "map");
    if (!map || map.supportLevel === "unsupported" || !map.supportedOperations.includes("draft.create"))
      throw new Error("Map draft creation is unavailable on this server. Ask the operator to enable it.");
    if (!entry.attachmentAllowed) throw new Error(CANCELLED_BEFORE_SUBMISSION);
    const metadata = await host.resolveRecipeSource(
      input.sourceId,
      AbortSignal.any([AbortSignal.timeout(15000), entry.metadataAbort!.signal]),
    );
    const { state } = compileExploreDataset(input, metadata);
    return {
      packageKey: input.packageKey,
      envelope: { ...MAP_COMPOSITION_ENVELOPE, body: toCompositionDraftBody(state, input.packageKey) },
    };
  }

  async #attachCreated(entry: RecipeSubmissionEntry, draftId: string): Promise<EditorDraftIdentity> {
    const { drafts } = this.options;
    const activeDraftId = drafts.identity?.draftId;
    if (!entry.attachmentAllowed)
      throw new Error(
        `Creation returned draft ${draftId} after this picker was closed. Reopen and retry this submission to attach that same draft.`,
      );
    if (activeDraftId === draftId) return drafts.identity!;
    if (activeDraftId !== entry.originalDraftId || drafts.identity?.generation !== entry.originalDraftGeneration)
      throw activeMapChanged(draftId);
    this.#draftToAttach = draftId;
    try {
      await drafts.attach(draftId, () => this.#requireAttachable(entry, draftId));
    } finally {
      this.#draftToAttach = undefined;
    }
    const identity = drafts.identity;
    if (!identity || identity.draftId !== draftId) throw new Error("Retry to attach the already created draft.");
    return identity;
  }

  #requireAttachable(entry: RecipeSubmissionEntry, draftId: string): void {
    this.#epoch.assertCurrent(entry.generation, REOPEN_IN_ORIGINAL_EDITOR);
    if (!entry.attachmentAllowed)
      throw new Error(
        `Draft ${draftId} was created, but attachment was cancelled. Open that draft explicitly to recover it.`,
      );
    const current = this.options.drafts.identity;
    if (current?.draftId !== entry.originalDraftId || current?.generation !== entry.originalDraftGeneration)
      throw activeMapChanged(draftId);
  }
}
