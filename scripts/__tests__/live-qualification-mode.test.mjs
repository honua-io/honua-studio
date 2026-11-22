import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertLifecycleReport,
  liveQualificationMode,
  qualificationBrowserScript,
} from "../lib/live-qualification-mode.mjs";

test("full qualification remains the default and scoped proof must be selected explicitly", () => {
  assert.equal(liveQualificationMode({}), "full");
  assert.equal(qualificationBrowserScript(liveQualificationMode({})), "test:browser:live");
  const scoped = liveQualificationMode({ HONUA_LIVE_QUALIFICATION_MODE: "oidc-lifecycle" });
  assert.equal(qualificationBrowserScript(scoped), "test:browser:live:oidc");
  for (const mode of ["", "typo", "FULL"]) {
    assert.throws(() => liveQualificationMode({ HONUA_LIVE_QUALIFICATION_MODE: mode }), /must be/);
  }
});

test("scoped proof rejects skipped, retried, missing or extra journeys", () => {
  const stats = { expected: 1, unexpected: 0, flaky: 0, skipped: 0 };
  assert.doesNotThrow(() => assertLifecycleReport({ stats }));
  assert.throws(() => assertLifecycleReport({}), /exactly one passing journey/);
  for (const override of [{ expected: 0 }, { expected: 2 }, { skipped: 1 }, { unexpected: 1 }, { flaky: 1 }]) {
    assert.throws(() => assertLifecycleReport({ stats: { ...stats, ...override } }), /exactly one passing journey/);
  }
});
