import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DRAFT_WRITER_PROTOCOLS } from "../../src/map/source-resolution.js";

const fixture: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/composition-reducer-cases.v1.json", import.meta.url), "utf8"),
);

function collectProtocols(node: unknown): unknown[] {
  if (Array.isArray(node)) return node.flatMap((item) => collectProtocols(item));
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) => (key === "protocol" ? [value] : collectProtocols(value)));
}

function protocolsOutsideWriter(node: unknown): unknown[] {
  const written = new Set<string>(DRAFT_WRITER_PROTOCOLS);
  return collectProtocols(node).filter((protocol) => typeof protocol !== "string" || !written.has(protocol));
}

describe("composition reducer fixture", () => {
  it("uses protocol values the draft writer emits", () => {
    expect(collectProtocols(fixture).length).toBeGreaterThan(0);
    expect(protocolsOutsideWriter(fixture)).toEqual([]);
  });

  it("keeps non-string and non-writer protocol values visible", () => {
    const sample = { sourceBindings: [{ protocol: null }, { protocol: "geoservices-feature-service" }] };
    expect(collectProtocols(sample)).toEqual([null, "geoservices-feature-service"]);
    expect(protocolsOutsideWriter(sample)).toEqual([null, "geoservices-feature-service"]);
  });
});
