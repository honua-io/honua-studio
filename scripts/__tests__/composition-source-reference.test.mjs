import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
const code = stripTypeScriptTypes(
  readFileSync(new URL("../../src/composition/source-reference.ts", import.meta.url), "utf8"),
  { mode: "transform" },
);
const { compositionDataSource } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
test("raw sources and distinct aliases share backing identity; ambiguous aliases and invalid references fail closed", () => {
  const state = {
    layers: [
      { id: "parcels", sourceId: "S" },
      { id: "sibling", sourceId: "S" },
    ],
  };
  for (const reference of ["S", "parcels", "sibling"]) assert.equal(compositionDataSource(state, reference), "S");
  const collision = {
    layers: [
      { id: "roads", sourceId: "parcels" },
      { id: "other", sourceId: "roads" },
    ],
  };
  assert.equal(compositionDataSource(collision, "roads"), undefined);
  const chain = {
    layers: [
      { id: "A", sourceId: "B" },
      { id: "B", sourceId: "S" },
    ],
  };
  assert.equal(compositionDataSource(chain, "A"), undefined);
  assert.equal(compositionDataSource(chain, "B"), undefined);
  for (const ref of ["S", "parcels", "sibling"]) {
    const resolved = compositionDataSource(state, ref);
    assert.equal(compositionDataSource(state, resolved), resolved);
  }
  for (const reference of ["", " ", " S", "S\n", "S\0"])
    assert.equal(compositionDataSource(state, reference), undefined);
});
