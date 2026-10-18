export interface SdkPayloadReceipt {
  readonly sourceCommit: string;
  readonly artifactSha256: string;
  readonly files: Readonly<Record<string, string>>;
}
export function verifySdkPayload(
  directory: string,
  receipt: SdkPayloadReceipt,
): {
  sourceCommit: string;
  artifactSha256: string;
  files: number;
};
