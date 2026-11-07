export function selectLiveModel(capabilities) {
  const allowed = capabilities.providers.filter(
    (provider) =>
      provider.configured &&
      provider.streaming &&
      ((provider.kind.toLowerCase() === "anthropic" && /^claude-opus-5-5(?:-\d{8})?$/.test(provider.model)) ||
        (provider.kind.toLowerCase() === "openai" && provider.model === "gpt-6.1-sol")),
  );
  const selected = allowed.find((provider) => provider.isDefault) ?? allowed[0];
  if (!capabilities.enabled || !selected) {
    throw new Error("Live demo needs a configured streaming Opus 5.5 or Sol provider over a direct provider adapter.");
  }
  return selected;
}

export async function approveLivePublication(baseUrl, proposalId, humanToken, fetchRequest = fetch) {
  if (!humanToken) throw new Error("HONUA_LIVE_HUMAN_TOKEN is required for the human approval step.");
  const url = new URL(`/api/v1/admin/proposals/${encodeURIComponent(proposalId)}/approve`, baseUrl);
  const response = await fetchRequest(url, {
    method: "POST",
    headers: { authorization: `Bearer ${humanToken}`, accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Human publication approval returned HTTP ${response.status}.`);
  return response.json();
}
