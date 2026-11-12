// @vitest-environment happy-dom
/**
 * Keeps retired vocabulary out of Studio's public names and user-facing text. The canonical terms are in
 * honua-server `docs/concepts/domain/README.md`; the shared policy is honua-server
 * `scripts/ci/retired-terms.v1.json`. Add an exception only for a deprecated alias, a server-owned wire name,
 * a filesystem/IDE workspace or the internal composition engine, with its reason.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as consoleEntry from "../../src/console-entry.js";
import { DEPRECATED_EVENT_ALIASES } from "../../src/elements/deprecated-aliases.js";
import { STUDIO_ELEMENT_TAGS, registerAllStudioElements } from "../../src/elements/registry.js";

const RETIRED_NAME =
  /workspace|package|famil(y|ies)|composition|web_?map|portal_?item|hosted_?layer|serving_?target|tenant|content_?item|honuaapitoken/i;
const RETIRED_TEXT =
  /\b(workspaces?|packages?|famil(y|ies)|compositions?|web ?maps?|portal items?|hosted layers?|serving targets?|tenants?|content items?)\b/i;

const DEPRECATED_EXPORTS = [
  "createWorkspaceAgentSession",
  "workspaceAgentFeatures",
  "ServerProcessWorkspace",
  "LocalProcessWorkspace",
  "createWorkspaceLifecycleReader",
  "WorkspaceLifecycleReader",
  "createReadOnlyCompositionView",
  "ReadOnlyCompositionView",
  "ReadOnlyCompositionViewOptions",
  "ReadOnlyCompositionDocument",
];

const DEPRECATED_MEMBERS = [
  "createWorkspaceStyleProvider",
  "setWorkspaceConversation",
  "enableLiveComposition",
  "disableLiveComposition",
  "createWorkspaceDraft",
  "attachWorkspaceDraft",
  "refreshWorkspaceDraft",
  "prepareWorkspaceTurn",
  "saveWorkspaceVersion",
  "listWorkspaceVersions",
  "reviewWorkspacePublication",
  "publishWorkspaceVersion",
  "readWorkspacePublication",
  "reopenWorkspaceVersion",
  "prepareWorkspaceTask",
  "attachWorkspaceTask",
  "refreshWorkspaceTask",
];

/** The handle on the internal composition engine (`src/composition/`); renaming it would be churn only. */
const COMPOSITION_ENGINE_MEMBERS = ["composition"];

/** Directories whose text is model-facing or contributor-facing rather than shown to users. */
const NOT_USER_FACING = [
  /^src\/evals\//,
  /\/fixtures\//,
  /^src\/chat\/system-prompt\.ts$/,
  /^src\/mcp\/composition-authoring-contract\.ts$/,
];

const TEXT_EXCEPTIONS: ReadonlyArray<{ readonly path: string; readonly text: string; readonly reason: string }> = [
  {
    path: "src/gp/custom-process-workspace.ts",
    text: "An actual workspace is required.",
    reason: "names the host's X-Honua-Workspace scope, a server-owned identifier",
  },
  {
    path: "src/gp/custom-process-workspace.ts",
    text: "The workspace changed during the request.",
    reason: "names the host's X-Honua-Workspace scope, a server-owned identifier",
  },
  {
    path: "src/elements/studio-custom-processes-element.ts",
    text: "No saved import exists for this owner, environment and workspace.",
    reason: "names the host's X-Honua-Workspace scope, a server-owned identifier",
  },
  {
    path: "src/elements/studio-processes-element.ts",
    text: "Custom Python and .NET projects use the separate code workspace.",
    reason: "a filesystem/IDE workspace",
  },
  {
    path: "src/elements/studio-processes-element.ts",
    text: "Expected a workflow-package.v1 graph",
    reason: "the server-owned workflow-package.v1 format literal",
  },
  {
    path: "src/composition/commands.ts",
    text: "is not a known composition command",
    reason: "validation from the internal composition engine",
  },
  {
    path: "src/composition/reducer.ts",
    text: "Invalid composition command:",
    reason: "validation from the internal composition engine",
  },
  {
    path: "src/mcp/tool-bridge.ts",
    text: "has no composition-engine counterpart yet",
    reason: "a tool-bridge reason naming the internal composition engine",
  },
  {
    path: "src/mcp/tool-bridge.ts",
    text: "not a composition mutation",
    reason: "a tool-bridge reason naming the internal composition engine",
  },
];

function retiredNames(names: Iterable<string>, allowed: readonly string[]): string[] {
  return [...names].filter((name) => RETIRED_NAME.test(name) && !allowed.includes(name));
}

function exportedTypeNames(path: string): string[] {
  const source = readFileSync(path, "utf8");
  return [...source.matchAll(/export (?:type|interface) (\w+)|\btype (\w+)[,\s}]/g)].map(
    (match) => match[1] ?? match[2],
  );
}

function sourceFiles(): string[] {
  return execFileSync("git", ["ls-files", "src/*.ts", "src/**/*.ts"], { encoding: "utf8" })
    .split("\n")
    .filter((path) => path && !NOT_USER_FACING.some((pattern) => pattern.test(path)));
}

/** Single-line string literals that read as prose (two words or more), without markup or interpolations. */
function proseLiterals(line: string): string[] {
  if (/^\s*(\/\/|\*|\/\*|import )/.test(line)) return [];
  return [...line.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)]
    .map((match) => match[2].replace(/\$\{[^}]*\}/g, " ").replace(/<[^>]*>/g, " "))
    .filter((text) => /[a-z]{2,} [a-z]{2,}/i.test(text));
}

function retiredTextFindings(): string[] {
  const findings: string[] = [];
  for (const path of sourceFiles()) {
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((line, index) => {
        for (const text of proseLiterals(line)) {
          const excepted = TEXT_EXCEPTIONS.some((entry) => entry.path === path && text.includes(entry.text));
          if (RETIRED_TEXT.test(text) && !excepted) findings.push(`${path}:${index + 1}: ${text}`);
        }
      });
  }
  return findings;
}

describe("retired vocabulary guard", () => {
  it("keeps retired words out of Console entry exports except listed deprecated aliases", () => {
    const names = [
      ...Object.keys(consoleEntry),
      ...exportedTypeNames("src/console-entry.ts"),
      ...exportedTypeNames("src/console-entry-deprecated.ts"),
    ];
    expect(retiredNames(names, DEPRECATED_EXPORTS)).toEqual([]);
  });

  it("keeps retired words out of element tags, attributes and members except listed deprecated aliases", () => {
    registerAllStudioElements();
    const names = new Set<string>(STUDIO_ELEMENT_TAGS);
    for (const tag of STUDIO_ELEMENT_TAGS) {
      const element = customElements.get(tag) as
        | (CustomElementConstructor & { observedAttributes?: string[] })
        | undefined;
      for (const attribute of element?.observedAttributes ?? []) names.add(attribute);
      for (const member of Object.getOwnPropertyNames(element?.prototype ?? {})) names.add(member);
    }
    expect(retiredNames(names, [...DEPRECATED_MEMBERS, ...COMPOSITION_ENGINE_MEMBERS])).toEqual([]);
  });

  it("dispatches retired event names only as deprecated aliases of current names", () => {
    const current = Object.keys(DEPRECATED_EVENT_ALIASES);
    expect(retiredNames(current, [])).toEqual([]);
    expect(Object.values(DEPRECATED_EVENT_ALIASES)).toEqual([
      "honua-workspace-draft-change",
      "honua-studio-composition-mode-change",
    ]);
  });

  it("keeps retired words out of user-facing strings except listed exceptions", () => {
    expect(retiredTextFindings()).toEqual([]);
  });

  it("lists only exceptions that still match source text", () => {
    const stale = TEXT_EXCEPTIONS.filter((entry) => !readFileSync(entry.path, "utf8").includes(entry.text));
    expect(stale).toEqual([]);
  });
});
