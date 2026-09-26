import { describe, expect, it } from "vitest";

import { planByomPreviewTurn } from "../../scripts/lib/byom-preview-model.mjs";

const catalog = [
  "honua_studio_add_layer",
  "honua_studio_set_view",
  "honua_studio_save_version",
  "honua_studio_reopen_version",
  "honua_studio_propose_publication",
  "honua_studio_remove_layer",
].map((name) => ({ name, inputSchema: { type: "object" } }));

const prompt = "Add the Hawaii parcels layer, save a version, reopen it, and propose sharing it.";

describe("byom preview model", () => {
  it("selects two composition tools from the full catalog before any tool result exists", () => {
    const turn = planByomPreviewTurn({
      messages: [{ role: "user", content: prompt }],
      tools: catalog,
    });
    expect(turn.events.filter((event) => event.type === "toolCallStop").map((event) => event.toolName)).toEqual([
      "honua_studio_add_layer",
      "honua_studio_set_view",
    ]);
    expect(turn.events.at(-1)).toMatchObject({ type: "messageStop", stopReason: "toolCall" });
  });

  it("saves, reopens, and proposes only after it has seen the previous tool results", () => {
    const saved = planByomPreviewTurn({
      messages: [
        { role: "user", content: prompt },
        {
          role: "tool",
          content: JSON.stringify({
            status: "ok",
            draft: { draftId: "d1", generation: 2, envelope: { body: { layers: [{ id: "hi-parcels" }] } } },
          }),
        },
      ],
      tools: catalog,
    });
    expect(saved.events.find((event) => event.type === "toolCallStop")?.toolName).toBe("honua_studio_save_version");

    const reopened = planByomPreviewTurn({
      messages: [
        { role: "user", content: prompt },
        {
          role: "tool",
          content: JSON.stringify({
            status: "ok",
            draft: {
              draftId: "d1",
              savedVersionId: "v1",
              savedItemId: "item-1",
              savedContentHash: "abc",
              envelope: { body: { layers: [{ id: "hi-parcels" }] } },
            },
          }),
        },
      ],
      tools: catalog,
    });
    expect(reopened.events.find((event) => event.type === "toolCallStop")).toMatchObject({
      toolName: "honua_studio_reopen_version",
      toolArguments: { itemId: "item-1", versionId: "v1" },
    });
  });

  it("does not compose for an unrelated prompt and refuses a forced tool", () => {
    const unrelated = planByomPreviewTurn({
      messages: [{ role: "user", content: "What is the weather in Honolulu?" }],
      tools: catalog,
    });
    expect(unrelated.events.some((event) => event.type === "toolCallStart")).toBe(false);
    expect(unrelated.events.find((event) => event.type === "textDelta")?.text).toMatch(/parcels map/);

    const forced = planByomPreviewTurn({
      messages: [{ role: "user", content: prompt }],
      tools: catalog,
      toolChoice: { mode: "specific", toolName: "honua_studio_add_layer" },
    });
    expect(forced.events[0]).toMatchObject({ type: "error" });
  });
});
