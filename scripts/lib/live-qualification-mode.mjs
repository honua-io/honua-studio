// Keep scoped human-approval proof separate from the full, paid qualification.
export function liveQualificationMode(environment = process.env) {
  const mode = environment.HONUA_LIVE_QUALIFICATION_MODE ?? "full";
  if (!["full", "oidc-lifecycle"].includes(mode)) {
    throw new Error("HONUA_LIVE_QUALIFICATION_MODE must be full or oidc-lifecycle.");
  }
  return mode;
}

export function qualificationBrowserScript(mode) {
  return mode === "oidc-lifecycle" ? "test:browser:live:oidc" : "test:browser:live";
}

export function assertLifecycleReport(report) {
  const { expected, unexpected, flaky, skipped } = report.stats ?? {};
  if (expected !== 1 || unexpected !== 0 || flaky !== 0 || skipped !== 0) {
    throw new Error("OIDC lifecycle qualification requires exactly one passing journey with no skips or retries.");
  }
}
