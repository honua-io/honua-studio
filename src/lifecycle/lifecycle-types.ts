/**
 * Wire types for honua-server's Studio package lifecycle API
 * (honua-io/honua-server `docs/internal/admin-api/studio-package-lifecycle.md`,
 * issue #1180) plus the content-item/draft enumeration endpoints added by
 * server PR #3014 (issue #3003) — `GET /content-items` and
 * `GET /package-drafts`, cursor pagination, and the joined publication
 * badge.
 *
 * Field names/casing mirror the server's `[JsonPropertyName]`-annotated DTOs
 * (`Honua.Core.Features.Studio.Domain.*`, `Honua.Server.Features.Studio.Models.*`)
 * exactly — every property here is already camelCase on the wire, so these
 * interfaces are usable directly against a real `ApiResponse<T>.data`
 * payload with zero translation. See `lifecycle-client.ts`'s module doc for
 * why this is a hand-rolled projection rather than an `@honua/sdk-js` import
 * (honua-sdk-js#780 hasn't published the lifecycle client yet).
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Enums (server: StudioPackageEnums.cs)
// ---------------------------------------------------------------------------

export type StudioPackageFamily =
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

export const STUDIO_PACKAGE_FAMILIES: readonly StudioPackageFamily[] = [
  "query",
  "analysis",
  "map",
  "dashboard",
  "report",
  "form",
  "app",
  "workflow",
  "gp",
  "etl",
];

export type StudioPackageOperation =
  | "draft.create"
  | "draft.read"
  | "draft.update"
  | "validate"
  | "preview-plan"
  | "content-version.create"
  | "content-version.read"
  | "content-version.compare"
  | "publish-request.create"
  | "reopen"
  | "rollback";

export type StudioPackageSupportLevel = "unsupported" | "limited" | "supported";
export type StudioPackagePersistenceMode = "in-memory" | "durable";
export type StudioPackageValidationStatus = "not-validated" | "valid" | "warning" | "invalid";
export type StudioPackageDiagnosticSeverity = "info" | "warning" | "error" | "blocker";
export type StudioPublicationRequestStatus = "accepted" | "pending" | "rejected";
export type StudioRollbackPointer = "current" | "published" | "both";

/** Derived lifecycle state for a Studio content item (server: `StudioContentItemState`). Distinct from a joined publication's route `lifecycle`. */
export type StudioContentItemState = "draft" | "current" | "published";

/** A joined publication's route lifecycle (Content Publication Registry API). */
export type StudioPublicationRouteLifecycle = "active" | "suspended" | "archived";

// ---------------------------------------------------------------------------
// Package envelope (server: StudioPackageModels.cs)
// ---------------------------------------------------------------------------

export interface StudioPackageBinding {
  readonly key: string;
  readonly kind: string;
  readonly ref: string;
  readonly crs?: string;
  readonly srid?: number;
  readonly units?: string;
  readonly requiredPermissions?: readonly string[];
  readonly metadata?: unknown;
}

export interface StudioPackageDependency {
  readonly ref: string;
  readonly kind: string;
  readonly versionId?: string;
  readonly required?: boolean;
  readonly metadata?: unknown;
}

export interface StudioValidationDiagnostic {
  readonly code: string;
  readonly severity: StudioPackageDiagnosticSeverity;
  readonly path?: string;
  readonly message: string;
}

export interface StudioValidationSummary {
  readonly status: StudioPackageValidationStatus;
  readonly diagnostics?: readonly StudioValidationDiagnostic[];
  readonly unsupportedCapabilities?: readonly string[];
  readonly generatedAt?: string;
}

export const NOT_VALIDATED_SUMMARY: StudioValidationSummary = { status: "not-validated", diagnostics: [] };

export interface StudioPublicationIntent {
  readonly route?: string;
  readonly visibility?: string;
  readonly embed?: boolean;
  readonly service?: string;
  readonly schedule?: string;
  readonly job?: string;
  readonly metadata?: unknown;
}

export interface StudioProvenanceRef {
  readonly kind: string;
  readonly ref: string;
  readonly rel: string;
  readonly actorId?: string;
  readonly timestamp?: string;
}

export interface StudioPackageEnvelope {
  readonly family: StudioPackageFamily;
  readonly schemaVersion: string;
  readonly format?: string;
  readonly bindings?: readonly StudioPackageBinding[];
  readonly dependencies?: readonly StudioPackageDependency[];
  readonly validation?: StudioValidationSummary;
  readonly publicationIntent?: StudioPublicationIntent | null;
  readonly provenance?: readonly StudioProvenanceRef[];
  readonly body?: unknown;
}

// ---------------------------------------------------------------------------
// Package family capabilities (GET /package-families)
// ---------------------------------------------------------------------------

export interface StudioPackageFamilyDescriptor {
  readonly family: StudioPackageFamily;
  readonly currentSchemaVersion: string;
  readonly format: string;
  readonly supportLevel: StudioPackageSupportLevel;
  readonly supportedOperations: readonly StudioPackageOperation[];
  readonly validationDepth: string;
  readonly limitations?: readonly string[];
  readonly maxPackageBytes: number;
  readonly previewSupported: boolean;
  readonly publishSupported: boolean;
}

export interface StudioPackageFamilyCapabilities {
  readonly persistenceMode: StudioPackagePersistenceMode;
  readonly durable: boolean;
  readonly families: readonly StudioPackageFamilyDescriptor[];
}

// ---------------------------------------------------------------------------
// Drafts (mutable)
// ---------------------------------------------------------------------------

export interface StudioPackageDraft {
  readonly draftId: string;
  readonly itemId: string;
  readonly packageKey: string;
  readonly workspaceId?: string;
  readonly ownerId?: string;
  readonly family: StudioPackageFamily;
  readonly envelope: StudioPackageEnvelope;
  readonly validation?: StudioValidationSummary;
  readonly baseVersionId?: string;
  readonly generation: number;
  readonly createdBy?: string;
  readonly updatedBy?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StudioPackageDraftCreateRequest {
  readonly packageKey: string;
  readonly workspaceId?: string;
  readonly ownerId?: string;
  readonly itemId?: string;
  readonly envelope: StudioPackageEnvelope;
}

/** Omit `generation` for last-write-wins; pass the last-seen value for strict optimistic concurrency (409 on staleness). */
export interface StudioPackageDraftReplaceRequest {
  readonly packageKey: string;
  readonly workspaceId?: string;
  readonly ownerId?: string;
  readonly envelope: StudioPackageEnvelope;
  readonly generation?: number;
}

// ---------------------------------------------------------------------------
// Content versions (immutable)
// ---------------------------------------------------------------------------

export interface StudioContentVersion {
  readonly itemId: string;
  readonly packageKey: string;
  readonly workspaceId?: string;
  readonly ownerId?: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly contentHash: string;
  readonly envelope: StudioPackageEnvelope;
  readonly validation: StudioValidationSummary;
  readonly dependencies?: readonly StudioPackageDependency[];
  readonly provenance?: readonly StudioProvenanceRef[];
  readonly sourceDraftId?: string;
  readonly baseVersionId?: string;
  readonly changeNote?: string;
  readonly createdBy?: string;
  readonly createdAt: string;
}

export interface StudioContentVersionListResponse {
  readonly itemId: string;
  readonly versions: readonly StudioContentVersion[];
}

export interface StudioContentItemPointers {
  readonly itemId: string;
  readonly currentVersionId?: string;
  readonly publishedVersionId?: string;
}

export interface StudioVersionComparisonRequest {
  readonly leftVersionId: string;
  readonly rightVersionId: string;
}

export interface StudioVersionComparison {
  readonly leftVersionId: string;
  readonly rightVersionId: string;
  readonly contentEqual: boolean;
  readonly dependenciesEqual: boolean;
  readonly validationEqual: boolean;
  readonly provenanceEqual: boolean;
  readonly changes: readonly string[];
}

export interface StudioPreviewPlan {
  readonly draftId: string;
  readonly family: StudioPackageFamily;
  readonly synchronous: boolean;
  readonly requiresJob: boolean;
  readonly steps: readonly string[];
  readonly validation: StudioValidationSummary;
}

// ---------------------------------------------------------------------------
// Publish / reopen / rollback — the human-confirmed lifecycle gates
// (spec REQ-009: propose-publication records INTENT on the draft; only a
// human-confirmed UI interaction may call requestPublish/requestRollback —
// see lifecycle-client.ts's module doc and studio-lifecycle-panel-element.ts.)
// ---------------------------------------------------------------------------

export interface StudioPublishRequestInput {
  /** Falls back to the version envelope's `publicationIntent` when omitted (matches server semantics). */
  readonly intent?: StudioPublicationIntent;
  readonly warningAcknowledgement?: string;
}

export interface StudioPublicationRequest {
  readonly requestId: string;
  readonly itemId: string;
  readonly versionId: string;
  readonly intent?: StudioPublicationIntent;
  readonly status: StudioPublicationRequestStatus;
  readonly validation?: StudioValidationSummary;
  readonly warningAcknowledgement?: string;
  readonly requestedBy?: string;
  readonly createdAt: string;
}

export interface StudioRollbackRequestInput {
  readonly targetVersionId: string;
  readonly pointer: StudioRollbackPointer;
  readonly reason?: string;
}

export interface StudioRollbackRequest {
  readonly requestId: string;
  readonly itemId: string;
  readonly targetVersionId: string;
  readonly pointer: StudioRollbackPointer;
  readonly pointers: StudioContentItemPointers;
  readonly requestedBy?: string;
  readonly reason?: string;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Enumeration (server PR #3014, issue #3003)
// ---------------------------------------------------------------------------

export interface StudioContentItemQuery {
  readonly families?: readonly StudioPackageFamily[];
  readonly workspaceId?: string;
  readonly owner?: string;
  readonly states?: readonly StudioContentItemState[];
  readonly q?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface StudioPackageDraftQuery {
  readonly families?: readonly StudioPackageFamily[];
  readonly workspaceId?: string;
  readonly owner?: string;
  readonly q?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface StudioContentItemPublicationBadge {
  readonly publicationId: string;
  readonly routeSlug: string;
  readonly routePath: string;
  readonly lifecycle: StudioPublicationRouteLifecycle;
  readonly activeRevision: number;
  readonly updatedAt: string;
}

export interface StudioContentItemSummary {
  readonly itemId: string;
  readonly packageKey: string;
  readonly workspaceId?: string;
  readonly family: StudioPackageFamily;
  readonly state: StudioContentItemState;
  readonly currentVersionId?: string;
  readonly publishedVersionId?: string;
  readonly createdBy?: string;
  readonly updatedBy?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly publication?: StudioContentItemPublicationBadge;
}

export interface StudioContentItemListResponse {
  readonly items: readonly StudioContentItemSummary[];
  readonly total: number;
  readonly nextCursor: string | null;
}

export interface StudioPackageDraftListResponse {
  readonly items: readonly StudioPackageDraft[];
  readonly total: number;
  readonly nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Envelope for successful responses (server: ApiResponse<T>)
// ---------------------------------------------------------------------------

export interface StudioApiResponse<T> {
  readonly success: true;
  readonly data: T;
  readonly timestamp: string;
}

/** RFC 7807 problem details, type `https://honua.io/problems/studio` — the shape every 400/404/409/500 from the lifecycle API uses. */
export interface StudioProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly [key: string]: unknown;
}
