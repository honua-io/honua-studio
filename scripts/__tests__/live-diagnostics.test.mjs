import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnosticRedactor } from "../lib/live-diagnostics.mjs";

const options = { root: "/nonexistent-studio-diagnostics", environment: {} };

test("explicit extra redaction values need no environment-variable aliases", () => {
  const redact = diagnosticRedactor({ ...options, extraValues: ["test-person", "private value"] });
  assert.equal(
    redact("test-person entered private value (private%20value)"),
    "[REDACTED] entered [REDACTED] ([REDACTED])",
  );
});

test("sign-in usernames from the environment are redacted, but not the runner account", () => {
  const redact = diagnosticRedactor({
    ...options,
    environment: { HONUA_LIVE_APPROVER_USERNAME: "approver-person", USERNAME: "runner" },
  });
  assert.equal(
    redact("textbox Username: approver-person in /home/runner"),
    "textbox Username: [REDACTED] in /home/runner",
  );
});

test("escaped JSON credentials are removed in full while error codes remain intact", () => {
  const redact = diagnosticRedactor(options);
  for (const key of ["password", "clientSecret", "client_secret", "secret", "authorization", "cookie"]) {
    const result = JSON.parse(redact(JSON.stringify({ [key]: 'private"trailing-content', code: "approval_denied" })));
    assert.deepEqual(result, { [key]: "[REDACTED]", code: "approval_denied" });
  }
});

test("OIDC query credentials are removed without hiding ordinary diagnostic state and code fields", () => {
  const redact = diagnosticRedactor(options);
  assert.equal(redact("state=Failed code=tool_rejected"), "state=Failed code=tool_rejected");
  assert.equal(redact("/callback?code=private-code&state=private-state"), "/callback?code=[REDACTED]&state=[REDACTED]");
});
