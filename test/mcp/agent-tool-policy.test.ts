import { describe, expect, it } from "vitest";

import { isGovernedStudioAgentTool, isGpAgentTool } from "../../src/mcp/agent-tool-policy.js";

describe("Studio agent tool policy", () => {
  it("allows bounded Studio mutations but excludes draft creation and arbitrary admin tools", () => {
    expect(isGovernedStudioAgentTool("honua_studio_add_layer")).toBe(true);
    expect(isGovernedStudioAgentTool("honua_studio_create_draft")).toBe(false);
    expect(isGovernedStudioAgentTool("honua_admin_delete_connection")).toBe(false);
  });

  it("keeps the exact server Esri GP roster eligible without defining a translator", () => {
    for (const advertised of [
      "honua_esri_gp_list_tasks",
      "honua_esri_gp_describe_task",
      "honua_esri_gp_execute_task",
    ]) {
      expect(isGovernedStudioAgentTool(advertised)).toBe(true);
      expect(isGpAgentTool(advertised)).toBe(true);
    }
  });

  it("allows the native buffer and governed save/get/reopen/propose lifecycle", () => {
    for (const advertised of [
      "honua_buffer_features",
      "honua_studio_save_version",
      "honua_studio_get_version",
      "honua_studio_reopen_version",
      "honua_studio_propose_publication",
    ]) {
      expect(isGovernedStudioAgentTool(advertised)).toBe(true);
    }
    expect(isGpAgentTool("honua_buffer_features")).toBe(true);
  });
});
