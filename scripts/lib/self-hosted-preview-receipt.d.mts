/**
 * Type declaration for self-hosted-preview-receipt.mjs, consulted only by `tsc --noEmit`.
 */

export declare const SELF_HOSTED_PREVIEW_RECEIPT_SCHEMA: "honua.studio.self-hosted-preview-receipt.v1";

export interface SelfHostedPreviewJourney {
  readonly draftId: string;
  readonly savedVersionId: string;
  readonly contentHash: string;
  readonly reopenedDraftId: string;
  readonly proposalId: string;
  readonly approvedUrl: string;
  readonly proposerSubject: string;
  readonly approverSubject: string;
  readonly toolNames: readonly string[];
}

export interface SelfHostedPreviewReceipt {
  readonly schemaVersion: typeof SELF_HOSTED_PREVIEW_RECEIPT_SCHEMA;
  readonly posture: "preview";
  readonly ga: false;
  readonly model: {
    readonly provider: "byom-preview";
    readonly kind: "catalog-planner";
    readonly hosted: false;
    readonly credentialRequired: false;
  };
  readonly image: { readonly published: false; readonly repository: string; readonly localImageId: string };
  readonly journey: SelfHostedPreviewJourney;
}

export declare function buildSelfHostedPreviewReceipt(input: {
  readonly posture?: string;
  readonly ga?: boolean;
  readonly sourceSha?: string;
  readonly sdk?: { readonly name?: string; readonly version?: string };
  readonly image?: {
    readonly repository?: string;
    readonly published?: boolean;
    readonly localImageId?: string;
    readonly digest?: string;
  };
  readonly runtimeConfig?: { readonly schemaVersion?: string; readonly modelMode?: string };
  readonly model?: { readonly provider?: string; readonly hosted?: boolean; readonly credentialRequired?: boolean };
  readonly journey?: Partial<SelfHostedPreviewJourney> & { readonly toolNames?: readonly string[] };
}): SelfHostedPreviewReceipt;
