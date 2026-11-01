const FEATURE_RESPONSE_BYTES_LIMIT = 16 * 1024 * 1024;

/** Only the cookie transport emits this marker after rejecting a superseded lease's bytes. */
export function isCookieLeaseRenewal(error: unknown): boolean {
  return error instanceof Error && error.name === "CookieLeaseRenewedError";
}

/** Read one feature-service response without allowing a stream or its fragments to grow without bound. */
export async function readBoundedFeatureBody(
  response: Response,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<ArrayBuffer> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > FEATURE_RESPONSE_BYTES_LIMIT) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Feature response exceeds the 16 MiB size limit.");
  }
  if (!response.body) {
    signal.throwIfAborted();
    if (!isCurrent()) throw new Error("The Studio session changed during the source request.");
    return new ArrayBuffer(0);
  }
  const reader = response.body.getReader();
  let bytes = new Uint8Array(0);
  let total = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      if (!isCurrent()) throw new Error("The Studio session changed during the source request.");
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (!isCurrent()) throw new Error("The Studio session changed during the source request.");
      if (done) break;
      const nextTotal = total + value.byteLength;
      if (nextTotal > FEATURE_RESPONSE_BYTES_LIMIT) throw new Error("Feature response exceeds the 16 MiB size limit.");
      if (nextTotal > bytes.byteLength) {
        let capacity = Math.max(bytes.byteLength, 1024);
        while (capacity < nextTotal) capacity = Math.min(capacity * 2, FEATURE_RESPONSE_BYTES_LIMIT);
        const expanded = new Uint8Array(capacity);
        expanded.set(bytes.subarray(0, total));
        bytes = expanded;
      }
      bytes.set(value, total);
      total = nextTotal;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  signal.throwIfAborted();
  if (!isCurrent()) throw new Error("The Studio session changed during the source request.");
  return bytes.buffer.slice(0, total);
}

export function parseFeatureResponseBody(buffer: ArrayBuffer): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
}
