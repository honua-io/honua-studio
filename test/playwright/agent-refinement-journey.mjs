import { expect } from "@playwright/test";
import { storedPaint } from "./helpers.mjs";

/** The draft body with `paint` merged into `layerId`'s paint, everything else kept. */
function bodyWithPaint(draft, layerId, paint) {
  const body = structuredClone(draft.envelope.body);
  const layer = body.mapSpec.layers.find((candidate) => candidate.id === layerId);
  layer.paint = { ...layer.paint, ...paint };
  return body;
}

/** One agent tool write of paint properties, made at the draft generation the agent was handed. */
function agentPaintWrite(agentCall, draft, generation, paint) {
  return agentCall("honua_studio_update_draft", {
    draftId: draft.draftId,
    generation,
    packageKey: draft.packageKey,
    schemaVersion: draft.envelope.schemaVersion,
    body: bodyWithPaint(draft, "explore-layer", paint),
  });
}

/** Pins the first control in the app, a human-only edit the server envelope never carries; returns it. */
function pinFirstControl(page) {
  return page.evaluate(() => {
    const { composition } = window.__honuaStudioApp;
    const target = { kind: "control", id: composition.state.controls[0].id };
    composition.apply({ name: "pin", target });
    return target;
  });
}

/** What the app holds outside the agent's paint edit: pins, controls, widgets and the view. */
function untargetedState(page) {
  return page.evaluate(() => {
    const { pins, controls, widgets, view } = window.__honuaStudioApp.composition.state;
    return { pins, controlIds: controls.map(({ id }) => id), widgetIds: widgets.map(({ id }) => id), view };
  });
}

function prepareEditorTurn(page) {
  return page.evaluate(() =>
    window.__honuaStudioApp.prepareEditorTurn().then(
      (identity) => ({ identity }),
      (error) => ({ refused: error.message }),
    ),
  );
}

/**
 * An agent turn after a visual edit starts from the saved revision, its write repaints the map without
 * losing the visual edit, a stale replay cannot overwrite newer work, and a human save that lost the race
 * says so and recovers through an explicit reload.
 */
export async function verifyAgentRefinement(page, { key, readDraft, agentCall, paintedLayer }) {
  const editor = page.getByRole("region", { name: "Map style editor", exact: true });
  await page.getByRole("button", { name: "Edit map style", exact: true }).click();
  await editor.getByLabel("Color", { exact: true }).fill("#2171b5");
  expect((await prepareEditorTurn(page)).refused).toContain("Save or explicitly reload");
  await editor.getByRole("button", { name: "Discard visual edits", exact: true }).click();
  await expect.poll(async () => (await paintedLayer())?.colors).toEqual(["#d94801"]);

  const pinned = await pinFirstControl(page);
  const untargeted = await untargetedState(page);
  expect(untargeted.pins).toEqual([pinned]);
  const saved = await readDraft(key);
  const { identity } = await prepareEditorTurn(page);
  expect(identity).toMatchObject({ draftId: saved.draftId, generation: saved.generation });

  const refined = await agentPaintWrite(agentCall, saved, identity.generation, { "fill-opacity": 0.9 });
  expect(refined.isError).toBeFalsy();
  expect(await page.evaluate(() => window.__honuaStudioApp.refreshEditorDraft())).toBe(true);
  await expect.poll(async () => (await paintedLayer())?.opacity).toEqual([0.9]);
  expect((await paintedLayer()).colors).toEqual(["#d94801"]);
  expect(await untargetedState(page)).toEqual(untargeted);

  const stale = await agentPaintWrite(agentCall, saved, identity.generation, { "fill-color": "#000000" });
  expect(stale.structuredContent.message).toContain("Stale draft generation");
  const afterStale = await readDraft(key);
  expect(storedPaint(afterStale, "explore-layer")).toMatchObject({ "fill-color": "#d94801", "fill-opacity": 0.9 });

  const racing = await agentPaintWrite(agentCall, afterStale, afterStale.generation, { "fill-opacity": 0.5 });
  expect(racing.isError).toBeFalsy();
  await editor.getByLabel("Color", { exact: true }).fill("#238b45");
  await editor.getByRole("button", { name: "Save map style", exact: true }).click();
  await expect(editor.getByRole("status")).toHaveText(
    "Another edit saved this map first. Discard visual edits to load it, then reapply yours.",
  );
  expect(storedPaint(await readDraft(key), "explore-layer")).toMatchObject({
    "fill-color": "#d94801",
    "fill-opacity": 0.5,
  });

  await editor.getByRole("button", { name: "Discard visual edits", exact: true }).click();
  await expect.poll(async () => (await paintedLayer())?.opacity).toEqual([0.5]);
  expect(await untargetedState(page)).toEqual(untargeted);
  await editor.getByLabel("Color", { exact: true }).fill("#238b45");
  await editor.getByRole("button", { name: "Save map style", exact: true }).click();
  await expect(editor.getByRole("status")).toHaveText("Map style saved to the authorized draft.");
  expect(storedPaint(await readDraft(key), "explore-layer")).toMatchObject({
    "fill-color": "#238b45",
    "fill-opacity": 0.5,
  });
  expect(await untargetedState(page)).toEqual(untargeted);
  await editor.getByRole("button", { name: "Close style editor", exact: true }).click();
}
