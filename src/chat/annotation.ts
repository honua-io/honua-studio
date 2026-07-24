/**
 * Deictic annotation-as-context (honua-studio#6, spec REQ-012). When
 * describing a target in words is hard, the user points instead — click a
 * map feature/layer/UI element, or draw a small marker/lasso region — and
 * the annotation becomes a typed reference chip in the composer that the
 * intent model consumes. This module owns the typed `AnnotationRef` model
 * and its serialization into the outgoing message context; the composer
 * chip lifecycle (add/remove/render) lives in `../elements/studio-chat-element.js`.
 *
 * The wire contract (honua-server#3010, `StudioAiChatMessage`) carries only
 * a plain `content: string` per turn — no structured context field — so
 * annotations are folded into that string deterministically
 * (`composeMessageContent`) rather than sent out-of-band.
 */

/** The four typed target kinds an annotation can resolve to (spec REQ-012). */
export type AnnotationKind = "layer" | "feature" | "region" | "component";

export interface LayerAnnotationPayload {
  readonly layerId: string;
}

export interface FeatureAnnotationPayload {
  readonly layerId: string;
  readonly featureId: string | number;
}

export interface RegionAnnotationPayload {
  /** `[minX, minY, maxX, maxY]` in the map's CRS, or a drawn screen-space rectangle — a region annotation carries exactly one of these. */
  readonly bbox?: readonly [number, number, number, number];
  readonly screen?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly crs?: string;
}

export interface ComponentAnnotationPayload {
  readonly componentId: string;
}

/** Maps an {@link AnnotationKind} to its typed payload shape. */
export type AnnotationPayloadOf<K extends AnnotationKind> = K extends "layer"
  ? LayerAnnotationPayload
  : K extends "feature"
    ? FeatureAnnotationPayload
    : K extends "region"
      ? RegionAnnotationPayload
      : ComponentAnnotationPayload;

/** A typed, removable, loggable, replayable reference chip (spec REQ-012). */
export interface AnnotationRef<K extends AnnotationKind = AnnotationKind> {
  readonly id: string;
  readonly kind: K;
  readonly label?: string;
  /** ISO 8601. Supplied by the caller (never `Date.now()` internally) so fixture-driven annotations replay byte-stably. */
  readonly createdAt: string;
  readonly payload: AnnotationPayloadOf<K>;
}

/** Input to `HonuaStudioChatElement.addAnnotation()` / `createAnnotationRef()`. `id`/`createdAt` are optional for live/interactive use (the element assigns them); fixture replay always supplies both explicitly for determinism. */
export interface CreateAnnotationInput<K extends AnnotationKind = AnnotationKind> {
  readonly kind: K;
  readonly payload: AnnotationPayloadOf<K>;
  readonly label?: string;
  readonly id?: string;
  readonly createdAt?: string;
}

/** Builds an {@link AnnotationRef} from fully-resolved fields. Pure — no id/clock generation (that's the caller's job; see `CreateAnnotationInput`). */
export function createAnnotationRef<K extends AnnotationKind>(input: {
  readonly id: string;
  readonly kind: K;
  readonly payload: AnnotationPayloadOf<K>;
  readonly label?: string;
  readonly createdAt: string;
}): AnnotationRef<K> {
  const ref: AnnotationRef<K> = {
    id: input.id,
    kind: input.kind,
    createdAt: input.createdAt,
    payload: input.payload,
    ...(input.label !== undefined ? { label: input.label } : {}),
  };
  return ref;
}

/** A short, human-readable chip label — used when the caller didn't supply an explicit `label`. */
export function annotationChipLabel(annotation: AnnotationRef): string {
  if (annotation.label) return annotation.label;
  switch (annotation.kind) {
    case "layer":
      return `Layer ${(annotation.payload as LayerAnnotationPayload).layerId}`;
    case "feature": {
      const payload = annotation.payload as FeatureAnnotationPayload;
      return `Feature ${payload.featureId} on ${payload.layerId}`;
    }
    case "region": {
      const payload = annotation.payload as RegionAnnotationPayload;
      if (payload.bbox) return `Region [${payload.bbox.join(", ")}]`;
      if (payload.screen) return `Region ${Math.round(payload.screen.width)}×${Math.round(payload.screen.height)}`;
      return "Region";
    }
    case "component":
      return `Component ${(annotation.payload as ComponentAnnotationPayload).componentId}`;
    default:
      return "Annotation";
  }
}

/**
 * Deterministically serializes annotation chips into the outgoing message
 * context (spec REQ-012). Insertion order is preserved (the order chips were
 * added, matching what the composer renders) so this is byte-stable across
 * runs given the same annotation list.
 */
export function serializeAnnotationsForContext(annotations: readonly AnnotationRef[]): string {
  if (annotations.length === 0) return "";
  const lines = annotations.map((a) => `- [${a.kind}] ${annotationChipLabel(a)} :: ${JSON.stringify(a.payload)}`);
  return `Context (user-selected references):\n${lines.join("\n")}`;
}

/** The exact `StudioAiChatMessage.content` string sent to the transport for a composer submit carrying `annotations`. */
export function composeMessageContent(text: string, annotations: readonly AnnotationRef[]): string {
  const context = serializeAnnotationsForContext(annotations);
  return context ? `${text}\n\n${context}` : text;
}
