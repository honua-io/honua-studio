export function bindObservedSources(
  sources: readonly Record<string, unknown>[],
  discovered: readonly Record<string, unknown>[],
  upstream: string,
  browserOrigin: string,
): Record<string, unknown>[];
