import { describe, expect, it } from "vitest";

import { StalenessEpoch } from "../../src/app/staleness-epoch.js";

describe("StalenessEpoch", () => {
  it("keeps a captured token current until the epoch advances", () => {
    const epoch = new StalenessEpoch();
    const token = epoch.current;

    expect(epoch.isCurrent(token)).toBe(true);
    const next = epoch.next();

    expect(epoch.isCurrent(token)).toBe(false);
    expect(epoch.isCurrent(next)).toBe(true);
    expect(epoch.current).toBe(next);
  });

  it("treats a missing token as stale", () => {
    expect(new StalenessEpoch().isCurrent(undefined)).toBe(false);
  });

  it("throws the caller's message only for a superseded token", () => {
    const epoch = new StalenessEpoch();
    const token = epoch.current;

    expect(() => epoch.assertCurrent(token, "superseded")).not.toThrow();
    epoch.next();
    expect(() => epoch.assertCurrent(token, "superseded")).toThrow("superseded");
  });
});
