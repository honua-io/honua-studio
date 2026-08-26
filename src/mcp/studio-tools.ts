/**
 * Typed wrappers over `McpClient.callTool` for 17 `honua_studio_*` tools
 * (honua-server#3002; `gh pr diff 3016` in honua-server — draft lifecycle:
 * create/get/update/validate/preview, composition mutation: add/remove
 * layer, set layer style, set layer visibility, set view, add/remove widget,
 * and propose_publication). One method per tool, each returning the tool's
 * plain JSON result — no lifecycle logic lives here, it all runs
 * server-side (AD-8: composition state IS the server draft).
 *
 * Field shapes mirror the server's DTOs exactly (`StudioMcpModels.cs`):
 * `styleRef` is a flat string binding (not this app's
 * `CompositionStyleRef` object) and the composed `view` carries an optional
 * `crs` this app's `CompositionView` does not — `tool-bridge.ts` owns
 * translating between the two, this module only owns the wire shapes.
 *
 * @module
 */
import type { McpClient } from "./client.js";
import type { McpToolsCallResult } from "./protocol.js";

// ---------------------------------------------------------------------------
// Wire shapes (mirror StudioMcpModels.cs / StudioCompositionBody)
// ---------------------------------------------------------------------------

export type StudioPackageFamilyWire =
  | "query"
  | "analysis"
  | "map"
  | "dashboard"
  | "report"
  | "form"
  | "app"
  | "workflow"
  | "gp"
  | "etl";

export interface StudioMcpLayerInput {
  readonly id: string;
  readonly sourceId?: string;
  readonly type?: string;
  readonly title?: string;
  readonly visible?: boolean;
  readonly styleRef?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface StudioMcpViewInput {
  readonly bbox?: readonly [number, number, number, number];
  readonly center?: readonly [number, number];
  readonly zoom?: number;
  readonly pitch?: number;
  readonly bearing?: number;
  readonly crs?: string;
}

export interface StudioMcpWidgetInput {
  readonly id: string;
  readonly kind: string;
  readonly title?: string;
  readonly sourceId?: string;
  readonly config?: Record<string, unknown>;
}

/** ADR-0031's control entry, as honua-server#3196 models it (`StudioCompositionControl`). Same shape as the widget entry, deliberately. */
export interface StudioMcpControlInput {
  readonly id: string;
  readonly kind: string;
  readonly title?: string;
  readonly sourceId?: string;
  readonly config?: Record<string, unknown>;
}

/** ADR-0030's binding, as honua-server#3175 models it (`StudioInteraction`). */
export interface StudioMcpInteractionInput {
  readonly id: string;
  readonly on: { readonly ref: string; readonly event: string };
  readonly do: { readonly ref: string; readonly verb: string; readonly args?: Record<string, unknown> };
  readonly disabled?: boolean;
}

export interface StudioCompositionBodyWire {
  readonly layers: readonly StudioMcpLayerInput[];
  readonly view: StudioMcpViewInput;
  readonly widgets: readonly StudioMcpWidgetInput[];
  /**
   * Optional, and **nullable rather than empty-by-default** on the server
   * side: honua-server#3175/#3196 keep both blocks unset until something
   * writes one, so an unrelated edit does not stamp `"controls": []` into
   * every stored package. This client mirrors that by omitting the key
   * entirely when the composition holds none.
   */
  readonly controls?: readonly StudioMcpControlInput[];
  readonly interactions?: readonly StudioMcpInteractionInput[];
}

/** Mirrors `StudioPackageDraft` restricted to the fields this app reads (matches `composition/history.ts`'s `CompositionDraft`). */
export interface StudioMcpDraft {
  readonly draftId: string;
  readonly itemId?: string;
  readonly packageKey: string;
  readonly workspaceId?: string;
  readonly ownerId?: string;
  readonly generation: number;
  readonly envelope: {
    readonly family: StudioPackageFamilyWire;
    readonly schemaVersion: string;
    readonly format?: string;
    readonly body?: StudioCompositionBodyWire | Record<string, unknown>;
  };
}

export interface StudioMcpValidationSummary {
  readonly isValid: boolean;
  readonly diagnostics?: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface StudioMcpPreviewPlan {
  readonly [key: string]: unknown;
}

export interface CreateStudioDraftInput {
  readonly packageKey: string;
  readonly family: StudioPackageFamilyWire;
  readonly schemaVersion: string;
  readonly workspaceId?: string;
  readonly ownerId?: string;
  readonly body?: unknown;
  readonly itemId?: string;
  readonly baseVersionId?: string;
}

export interface UpdateStudioDraftInput {
  readonly draftId: string;
  readonly generation: number;
  readonly packageKey: string;
  readonly schemaVersion: string;
  readonly format?: string;
  readonly workspaceId?: string;
  readonly ownerId?: string;
  readonly body?: unknown;
}

export interface AddStudioLayerInput {
  readonly draftId: string;
  readonly generation: number;
  readonly layer: StudioMcpLayerInput;
  readonly beforeId?: string;
}

export interface RemoveStudioLayerInput {
  readonly draftId: string;
  readonly generation: number;
  readonly layerId: string;
}

export interface SetStudioLayerStyleInput {
  readonly draftId: string;
  readonly generation: number;
  readonly layerId: string;
  readonly styleRef?: string;
}

/**
 * `honua_studio_set_layer_visibility` (honua-server#3199, landed in
 * honua-server PR #3207). All four fields are required and the tool's schema
 * is `additionalProperties: false`, so this shape is exact, not a subset: a
 * stale `generation` comes back `failed_precondition`, an id no layer in the
 * draft carries comes back `not_found`.
 */
export interface SetStudioLayerVisibilityInput {
  readonly draftId: string;
  readonly generation: number;
  readonly layerId: string;
  readonly visible: boolean;
}

export interface SetStudioViewInput {
  readonly draftId: string;
  readonly generation: number;
  readonly view: StudioMcpViewInput;
}

export interface AddStudioWidgetInput {
  readonly draftId: string;
  readonly generation: number;
  readonly widget: StudioMcpWidgetInput;
}

export interface RemoveStudioWidgetInput {
  readonly draftId: string;
  readonly generation: number;
  readonly widgetId: string;
}

export interface AddStudioControlInput {
  readonly draftId: string;
  readonly generation: number;
  readonly control: StudioMcpControlInput;
}

export interface RemoveStudioControlInput {
  readonly draftId: string;
  readonly generation: number;
  readonly controlId: string;
  readonly cascadeInteractions?: boolean;
}

export interface BindStudioInteractionInput {
  readonly draftId: string;
  readonly generation: number;
  readonly interaction: StudioMcpInteractionInput;
}

export interface RemoveStudioInteractionInput {
  readonly draftId: string;
  readonly generation: number;
  readonly interactionId: string;
}

export interface ProposeStudioPublicationInput {
  readonly draftId: string;
  readonly generation: number;
  readonly route?: string;
  readonly visibility?: string;
  readonly embed?: boolean;
  readonly service?: string;
  readonly schedule?: string;
  readonly job?: string;
  readonly note?: string;
}

export interface ProposeStudioPublicationOutput {
  readonly draft: StudioMcpDraft;
  readonly recorded: boolean;
  readonly humanConfirmationRequired: boolean;
  readonly message: string;
}

/** The tool name published in `tools/list` for every `honua_studio_*` tool (honua-server#3002). */
export const STUDIO_MCP_TOOL_NAMES = [
  "honua_studio_create_draft",
  "honua_studio_get_draft",
  "honua_studio_update_draft",
  "honua_studio_validate_draft",
  "honua_studio_preview_draft",
  "honua_studio_add_layer",
  "honua_studio_remove_layer",
  "honua_studio_set_layer_style",
  "honua_studio_set_layer_visibility",
  "honua_studio_set_view",
  "honua_studio_add_widget",
  "honua_studio_remove_widget",
  "honua_studio_add_control",
  "honua_studio_remove_control",
  "honua_studio_bind_interaction",
  "honua_studio_remove_interaction",
  "honua_studio_propose_publication",
] as const;

export type StudioMcpToolName = (typeof STUDIO_MCP_TOOL_NAMES)[number];

function structured<T>(result: McpToolsCallResult): T {
  if (result.structuredContent !== undefined) return result.structuredContent as T;
  const text = result.content?.find((block) => block.type === "text")?.text;
  if (text !== undefined) return JSON.parse(text) as T;
  throw new Error("MCP tool call succeeded but returned no structuredContent or text content to parse.");
}

/**
 * Parses a raw `tools/call` result from ANY of the draft-returning
 * `honua_studio_*` tools (create/update/add-layer/remove-layer/…) into a
 * {@link StudioMcpDraft}. Exported for `../mcp/orchestrator.ts`'s generic,
 * bridge-driven dispatch path, which calls `McpClient.callTool` directly
 * (by a tool name resolved at runtime) rather than through one of this
 * class's named methods.
 */
export function parseStudioDraftResult(result: McpToolsCallResult): StudioMcpDraft {
  return structured<StudioMcpDraft>(result);
}

/**
 * Typed convenience layer over {@link McpClient.callTool} for the 17
 * `honua_studio_*` tools. Every method is a thin `callTool(name, args)` plus
 * response parsing (`structuredContent`, falling back to the first text
 * block as JSON — the tool success side of the same shape
 * `client.ts`'s `parseToolError` reads on the failure side).
 */
export class StudioMcpToolClient {
  public constructor(private readonly client: McpClient) {}

  public async createDraft(input: CreateStudioDraftInput): Promise<StudioMcpDraft> {
    const result = await this.client.callTool("honua_studio_create_draft", { ...input });
    return structured<StudioMcpDraft>(result);
  }

  public async getDraft(draftId: string): Promise<StudioMcpDraft> {
    const result = await this.client.callTool("honua_studio_get_draft", { draftId });
    return structured<StudioMcpDraft>(result);
  }

  public async updateDraft(input: UpdateStudioDraftInput): Promise<StudioMcpDraft> {
    const result = await this.client.callTool("honua_studio_update_draft", { ...input });
    return structured<StudioMcpDraft>(result);
  }

  public async validateDraft(draftId: string): Promise<StudioMcpValidationSummary> {
    const result = await this.client.callTool("honua_studio_validate_draft", { draftId });
    return structured<StudioMcpValidationSummary>(result);
  }

  public async previewDraft(draftId: string): Promise<StudioMcpPreviewPlan> {
    const result = await this.client.callTool("honua_studio_preview_draft", { draftId });
    return structured<StudioMcpPreviewPlan>(result);
  }

  public async addLayer(input: AddStudioLayerInput): Promise<StudioMcpDraft> {
    const result = await this.client.callTool("honua_studio_add_layer", { ...input });
    return structured<StudioMcpDraft>(result);
  }

  public async removeLayer(input: RemoveStudioLayerInput): Promise<StudioMcpDraft> {
    const result = await this.client.callTool("honua_studio_remove_layer", { ...input });
    return structured<StudioMcpDraft>(result);
  }

  public async setLayerStyle(input: SetStudioLayerStyleInput): Promise<StudioMcpDraft> {
    const result = await this.client.callTool("honua_studio_set_layer_style", { ...input });
    return structured<StudioMcpDraft>(result);
  }

  /** `honua_studio_set_layer_visibility` — the durable half of a TOC toggle (honua-studio#31). `visible` is part of the server's `StudioCompositionLayer`, so this is what makes a toggle survive a draft sync. */
  public async setLayerVisibility(input: SetStudioLayerVisibilityInput): Promise<StudioMcpDraft> {
    const result = await this.client.callTool("honua_studio_set_layer_visibility", { ...input });
    return structured<StudioMcpDraft>(result);
  }

  public async setView(input: SetStudioViewInput): Promise<StudioMcpDraft> {
    const result = await this.client.callTool("honua_studio_set_view", { ...input });
    return structured<StudioMcpDraft>(result);
  }

  public async addWidget(input: AddStudioWidgetInput): Promise<StudioMcpDraft> {
    const result = await this.client.callTool("honua_studio_add_widget", { ...input });
    return structured<StudioMcpDraft>(result);
  }

  public async removeWidget(input: RemoveStudioWidgetInput): Promise<StudioMcpDraft> {
    const result = await this.client.callTool("honua_studio_remove_widget", { ...input });
    return structured<StudioMcpDraft>(result);
  }

  public async addControl(input: AddStudioControlInput): Promise<StudioMcpDraft> {
    const result = await this.client.callTool("honua_studio_add_control", { ...input });
    return structured<StudioMcpDraft>(result);
  }

  public async removeControl(input: RemoveStudioControlInput): Promise<StudioMcpDraft> {
    const result = await this.client.callTool("honua_studio_remove_control", { ...input });
    return structured<StudioMcpDraft>(result);
  }

  public async bindInteraction(input: BindStudioInteractionInput): Promise<StudioMcpDraft> {
    const result = await this.client.callTool("honua_studio_bind_interaction", { ...input });
    return structured<StudioMcpDraft>(result);
  }

  public async removeInteraction(input: RemoveStudioInteractionInput): Promise<StudioMcpDraft> {
    const result = await this.client.callTool("honua_studio_remove_interaction", { ...input });
    return structured<StudioMcpDraft>(result);
  }

  public async proposePublication(input: ProposeStudioPublicationInput): Promise<ProposeStudioPublicationOutput> {
    const result = await this.client.callTool("honua_studio_propose_publication", { ...input });
    return structured<ProposeStudioPublicationOutput>(result);
  }
}
