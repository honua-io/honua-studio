/**
 * Local BYOM planner for the 2026.1 self-hosted Studio preview.
 *
 * This is not a hosted model and not a sealed checkpoint replay. Each turn
 * sees the full tool catalog the caller advertised and the tool results so
 * far, then selects the next Studio tools itself. A request that forces one
 * specific tool is refused. Selections are executed by StudioAgentSession
 * against the live draft store; this module only chooses.
 */

const JOURNEY_TOOLS = [
  "honua_studio_add_layer",
  "honua_studio_set_view",
  "honua_studio_save_version",
  "honua_studio_reopen_version",
  "honua_studio_propose_publication",
];

const PARCELS_LAYER = {
  id: "hi-parcels",
  sourceId: "hi-parcels",
  title: "Hawai'i statewide parcels",
};

export function planByomPreviewTurn({ messages, tools, toolChoice }) {
  if (toolChoice?.mode === "specific") {
    return {
      events: errorEvents("The preview model refuses a forced single-tool choice."),
    };
  }

  const history = Array.isArray(messages) ? messages : [];
  const advertised = new Set(
    (Array.isArray(tools) ? tools : []).map((tool) => tool?.name).filter((name) => typeof name === "string"),
  );
  const lastUserIndex = history.findLastIndex((message) => message?.role === "user");
  const userText = lastUserIndex === -1 ? "" : String(history[lastUserIndex]?.content ?? "");
  const turnMessages = lastUserIndex === -1 ? [] : history.slice(lastUserIndex + 1);

  if (!/parcels/i.test(userText)) {
    return {
      events: textEvents(
        "I only compose, save, reopen, and propose a Studio map from the advertised tools. Ask for the parcels map when you want that preview.",
      ),
    };
  }

  const missing = JOURNEY_TOOLS.filter((name) => !advertised.has(name));
  if (missing.length > 0) {
    return {
      events: errorEvents(`The advertised Studio catalog is missing ${missing.join(", ")}.`),
    };
  }

  const turnTools = turnMessages.filter((message) => message?.role === "tool");
  const toolText = turnTools.map((message) => String(message.content ?? "")).join("\n");
  if (/"status"\s*:\s*"error"/.test(toolText)) {
    return { events: textEvents("A selected Studio tool failed. I am not repeating a sealed action.") };
  }

  const priorTools = turnTools.length;
  if (!toolText.includes(PARCELS_LAYER.id)) {
    return {
      events: toolEvents(priorTools, [
        ["honua_studio_add_layer", { layer: PARCELS_LAYER }],
        ["honua_studio_set_view", { view: { center: [-157.858, 21.306], zoom: 8 } }],
      ]),
    };
  }
  if (!toolText.includes("savedVersionId")) {
    return {
      events: toolEvents(priorTools, [["honua_studio_save_version", { changeNote: "Self-hosted preview save" }]]),
    };
  }
  if (!toolText.includes("reopenedFromVersionId")) {
    const versionId = jsonField(toolText, "savedVersionId");
    const itemId = jsonField(toolText, "savedItemId");
    if (!versionId || !itemId) {
      return { events: textEvents("The save result did not include a version binding.") };
    }
    return { events: toolEvents(priorTools, [["honua_studio_reopen_version", { itemId, versionId }]]) };
  }
  if (!toolText.includes("proposalId")) {
    const versionId = jsonField(toolText, "savedVersionId");
    const itemId = jsonField(toolText, "savedItemId");
    const contentHash = jsonField(toolText, "savedContentHash");
    if (!versionId || !itemId || !contentHash) {
      return { events: textEvents("The save result did not include the version binding.") };
    }
    return {
      events: toolEvents(priorTools, [
        [
          "honua_studio_propose_publication",
          {
            itemId,
            versionId,
            contentHash,
            route: "/maps/self-hosted-preview",
            visibility: "organization",
            note: "Share this preview with my team.",
          },
        ],
      ]),
    };
  }
  return {
    events: textEvents(
      "Saved the parcels map, reopened that version, and proposed it. A separate approver has to publish the link.",
    ),
  };
}

function jsonField(text, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(text);
  return match?.[1];
}

function toolEvents(priorTools, calls) {
  const events = [];
  calls.forEach(([toolName, toolArguments], index) => {
    const toolCallId = `byom-${priorTools + index + 1}`;
    events.push({ type: "toolCallStart", toolCallId, toolName });
    events.push({ type: "toolCallDelta", toolCallId, toolArgumentsDelta: JSON.stringify(toolArguments) });
    events.push({ type: "toolCallStop", toolCallId, toolName, toolArguments });
  });
  events.push({ type: "messageStop", stopReason: "toolCall" });
  return events;
}

function textEvents(text) {
  return [
    { type: "textDelta", text },
    { type: "messageStop", stopReason: "endTurn" },
  ];
}

function errorEvents(errorMessage) {
  return [{ type: "error", errorMessage }];
}
