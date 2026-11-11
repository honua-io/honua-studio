import assert from "node:assert/strict";
import { test } from "node:test";
import {
  liveReadinessEvidence,
  selectLiveModel,
} from "../../test/playwright/live-journey-contract.mjs";

const opus = {
  provider: "opus",
  kind: "anthropic",
  model: "claude-opus-5-5",
  configured: true,
  streaming: true,
  isDefault: true,
};

test("live model selection refuses unsupported adapters, models and unavailable providers", () => {
  for (const override of [
    { kind: "bedrock" },
    { model: "claude-sonnet-4-5" },
    { model: "claude-opus-4-6" },
    { configured: false },
    { streaming: false },
  ]) {
    assert.throws(() => selectLiveModel({ enabled: true, providers: [{ ...opus, ...override }] }));
  }
  assert.throws(() => selectLiveModel({ enabled: false, providers: [opus] }));
  assert.throws(() => selectLiveModel({ enabled: true, providers: [] }));
});

test("live model selection chooses an approved configured provider without using a disallowed default", () => {
  const sol = { ...opus, provider: "sol", kind: "openai", model: "gpt-6.1-sol", isDefault: false };
  assert.equal(selectLiveModel({ enabled: true, providers: [opus, sol] }), opus);
  assert.equal(selectLiveModel({ enabled: true, providers: [{ ...opus, kind: "bedrock" }, sol] }), sol);
});

test("tool model selection prefers a capable approved provider over an incompatible default", () => {
  const toolProvider = { ...opus, provider: "tools", toolSupport: true, isDefault: false };
  assert.equal(
    selectLiveModel({ enabled: true, providers: [{ ...opus, toolSupport: false }, toolProvider] }, [
      "streaming",
      "toolSupport",
    ]),
    toolProvider,
  );
  assert.throws(() => selectLiveModel({ enabled: false }));
});

test("readiness evidence excludes provider identities, model identifiers, signing material and credentials", () => {
  const capabilities = {
    enabled: true,
    defaultProvider: "private-provider-name",
    transcriptSigning: { keys: ["private-signing-metadata"] },
    providers: [{ ...opus, credential: "private-provider-credential", toolSupport: true }],
  };
  const evidence = liveReadinessEvidence(capabilities, { consoleApprovalConfigured: true });
  assert.deepEqual(evidence, {
    enabled: true,
    approvedProviderAvailable: true,
    providers: [{ kind: "anthropic", configured: true, streaming: true, toolSupport: true, isDefault: true }],
    consoleApprovalConfigured: true,
  });
  assert.equal(liveReadinessEvidence({ enabled: false }, {}).approvedProviderAvailable, false);
  assert.equal(
    liveReadinessEvidence({ enabled: true, providers: [{ ...opus, kind: "bedrock" }] }, {}).approvedProviderAvailable,
    false,
  );
});
