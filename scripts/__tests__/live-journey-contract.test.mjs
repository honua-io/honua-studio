import assert from "node:assert/strict";
import { test } from "node:test";
import { approveLivePublication, selectLiveModel } from "../../test/playwright/live-journey-contract.mjs";

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

test("publication approval requires a human credential before making any request", async () => {
  await assert.rejects(
    approveLivePublication("https://example.test/api", "proposal-1", undefined, () => assert.fail("must not send")),
    /HONUA_LIVE_HUMAN_TOKEN/,
  );
});

test("publication approval uses only the human bearer and preserves the server outcome", async () => {
  const receipt = { proposalId: "proposal-1", status: "Active" };
  const result = await approveLivePublication("https://example.test/api", "proposal-1", "fixture-human", (url, init) => {
    assert.equal(url.href, "https://example.test/api/v1/admin/proposals/proposal-1/approve");
    assert.equal(init.method, "POST");
    assert.deepEqual(init.headers, { authorization: "Bearer fixture-human", accept: "application/json" });
    return Response.json(receipt);
  });
  assert.deepEqual(result, receipt);
});

test("a refused human approval cannot become publication success", async () => {
  await assert.rejects(
    approveLivePublication("https://example.test/api", "proposal-1", "fixture-human", () => new Response(null, { status: 403 })),
    /HTTP 403/,
  );
});
