function approvedLiveProvider(provider) {
  return (
    (provider.kind.toLowerCase() === "anthropic" && /^claude-opus-5-5(?:-\d{8})?$/.test(provider.model)) ||
    (provider.kind.toLowerCase() === "openai" && provider.model === "gpt-6.1-sol")
  );
}

export function selectLiveModel(capabilities, requiredCapabilities = ["streaming"]) {
  const allowed = (capabilities.providers ?? []).filter(
    (provider) =>
      provider.configured && requiredCapabilities.every((name) => provider[name]) && approvedLiveProvider(provider),
  );
  const selected = allowed.find((provider) => provider.isDefault) ?? allowed[0];
  if (!capabilities.enabled || !selected) {
    throw new Error("Live demo needs a configured streaming Opus 5.5 or Sol provider outside the Bedrock adapter.");
  }
  return selected;
}

export function liveReadinessEvidence(capabilities, { consoleApprovalConfigured = false } = {}) {
  return {
    enabled: capabilities.enabled,
    approvedProviderAvailable: Boolean(
      capabilities.enabled &&
        capabilities.providers?.some(
          (provider) => provider.configured && provider.streaming && approvedLiveProvider(provider),
        ),
    ),
    providers: (capabilities.providers ?? []).map(({ kind, configured, streaming, toolSupport, isDefault }) => ({
      kind,
      configured,
      streaming,
      toolSupport,
      isDefault,
    })),
    consoleApprovalConfigured,
  };
}
