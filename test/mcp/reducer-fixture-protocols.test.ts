import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DRAFT_WRITER_PROTOCOLS } from "../../src/map/source-resolution.js";

const fixture: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/composition-reducer-cases.v1.json", import.meta.url), "utf8"),
);

function collectProtocols(node: unknown, found: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectProtocols(item, found);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "protocol" && typeof value === "string") found.push(value);
    else collectProtocols(value, found);
  }
}

describe("composition reducer fixture", () => {
  it("uses protocol values the draft writer emits", () => {
    const protocols: string[] = [];
    collectProtocols(fixture, protocols);
    expect(protocols.length).toBeGreaterThan(0);
    const written = new Set<string>(DRAFT_WRITER_PROTOCOLS);
    expect(protocols.filter((protocol) => !written.has(protocol))).toEqual([]);
  });
});
