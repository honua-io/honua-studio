import { describe, expect, it } from "vitest";
import { REQUIRED_SDK_GIT_HEAD, verifySdkPublication } from "../../scripts/verify-sdk-publication.mjs";

const valid = {
  dependencyVersion: "0.1.8",
  lockEntry: {
    version: "0.1.8",
    resolved: "https://registry.npmjs.org/@honua/sdk-js/-/sdk-js-0.1.8.tgz",
    integrity: "sha512-exact",
  },
  metadata: {
    version: "0.1.8",
    gitHead: REQUIRED_SDK_GIT_HEAD,
    "dist.integrity": "sha512-exact",
    "dist.tarball": "https://registry.npmjs.org/@honua/sdk-js/-/sdk-js-0.1.8.tgz",
  },
};

describe("release SDK publication gate", () => {
  it("accepts only the public package from exact sdk-js 5d5483f1 with matching lock integrity", () => {
    expect(() => verifySdkPublication(valid)).not.toThrow();
  });

  it("refuses the currently occupied stale beta coordinate", () => {
    expect(() =>
      verifySdkPublication({
        dependencyVersion: "0.1.7-beta.0",
        lockEntry: {
          version: "0.1.7-beta.0",
          resolved: "https://registry.npmjs.org/@honua/sdk-js/-/sdk-js-0.1.7-beta.0.tgz",
          integrity: "sha512-stale",
        },
        metadata: {
          version: "0.1.7-beta.0",
          gitHead: "2327a2a63f125165953e4ed789257c16d4a5c8f2",
          "dist.integrity": "sha512-stale",
          "dist.tarball": "https://registry.npmjs.org/@honua/sdk-js/-/sdk-js-0.1.7-beta.0.tgz",
        },
      }),
    ).toThrow(REQUIRED_SDK_GIT_HEAD);
  });

  it("refuses registry bytes that do not match the lock", () => {
    expect(() =>
      verifySdkPublication({ ...valid, metadata: { ...valid.metadata, "dist.integrity": "sha512-other" } }),
    ).toThrow("package-lock");
  });
});
