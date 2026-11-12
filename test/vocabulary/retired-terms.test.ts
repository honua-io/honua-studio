// @vitest-environment happy-dom
/**
 * Keeps retired vocabulary out of Studio's public names and user-facing text. The canonical terms are in
 * honua-server `docs/concepts/domain/README.md`; the shared policy is honua-server
 * `scripts/ci/retired-terms.v1.json`. Studio is unreleased, so renamed public names have no deprecated aliases:
 * the old names below may appear only in the files listed in RENAME_RECORDS. Add an exception only for a server-owned
 * wire name, a filesystem/IDE workspace or the internal composition engine, with its reason.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as consoleEntry from "../../src/console-entry.js";
import { STUDIO_ELEMENT_TAGS, registerAllStudioElements } from "../../src/elements/registry.js";

const RETIRED_NAME =
  /workspace|package|famil(y|ies)|composition|web_?map|portal_?item|hosted_?layer|serving_?target|tenant|content_?item|honuaapitoken/i;
const RETIRED_TEXT =
  /\b(workspaces?|packages?|famil(y|ies)|compositions?|web ?maps?|portal items?|hosted layers?|serving targets?|tenants?|content items?)\b/i;

/** Renamed Console entry exports and types; docs/vocabulary-renames.md lists their new names. */
const RENAMED_EXPORTS = [
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
  "HonuaStudioCompositionModeChangeDetail",
  "LiveCompositionOptions",
];

/** Renamed element methods. */
const RENAMED_MEMBERS = [
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

/** Renamed events, host attribute (and its `dataset` spelling), global and activity-log values. */
const RENAMED_DOM_NAMES = [
  "honua-workspace-draft-change",
  "honua-studio-composition-mode-change",
  "data-workspace-host",
  "workspaceHost",
  "HonuaStudioWorkspace",
  "composition_mode_changed",
  "workspace-command",
];

const RENAMED_NAMES = [...RENAMED_EXPORTS, ...RENAMED_MEMBERS, ...RENAMED_DOM_NAMES];

/** The rename list: every old name with its new name. */
const RENAMES_DOC = "docs/vocabulary-renames.md";

/** The only tracked files that may still name a renamed public name, with the reason. */
const RENAME_RECORDS: ReadonlyArray<{ readonly path: string; readonly reason: string }> = [
  { path: RENAMES_DOC, reason: "the rename list" },
  { path: "test/vocabulary/retired-terms.test.ts", reason: "this guard's list of renamed names" },
  {
    path: "scripts/__tests__/live-publication.test.mjs",
    reason: "Console pin 97631d3 contract until the Studio lock bump",
  },
];

/** Element members allowed to keep a retired word, with the reason. */
const ALLOWED_MEMBERS: ReadonlyArray<{ readonly name: string; readonly reason: string }> = [
  { name: "composition", reason: "the handle on the internal composition engine (`src/composition/`)" },
  { name: "packageKey", reason: "a server-owned wire name kept by AGENTS.md until the server rename" },
  { name: "family", reason: "a server-owned wire name kept by AGENTS.md until the server rename" },
];

/** Directories whose text is model-facing or contributor-facing rather than shown to users. */
const NOT_USER_FACING = [
  /^src\/evals\//,
  /\/fixtures\//,
  /^src\/chat\/system-prompt\.ts$/,
  /^src\/mcp\/composition-authoring-contract\.ts$/,
];

const TEXT_EXCEPTIONS: ReadonlyArray<{ readonly path: string; readonly text: string; readonly reason: string }> = [
  {
    path: "src/gp/custom-process-editor.ts",
    text: "An actual workspace is required.",
    reason: "names the host's X-Honua-Workspace scope, a server-owned identifier",
  },
  {
    path: "src/gp/custom-process-editor.ts",
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
  const declared = [...source.matchAll(/export (?:type|interface) (\w+)/g)].map((match) => match[1]);
  const listed = [...source.matchAll(/export (?:type )?\{([^}]*)\}/g)].flatMap((match) =>
    match[1]
      .split(",")
      .map(
        (entry) =>
          entry
            .replace(/^\s*type\s+/, "")
            .split(/\s+as\s+/)
            .pop()
            ?.trim() ?? "",
      )
      .filter(Boolean),
  );
  return [...declared, ...listed];
}

function dispatchedEventNames(): string[] {
  const names = new Set<string>();
  for (const path of sourceFiles()) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/(?:CustomEvent|dispatchTypedEvent)(?:<[^>(]*>)?\(\s*"([\w-]+)"/g))
      names.add(match[1]);
  }
  return [...names];
}

function publicMemberNames(tag: string): string[] {
  const element = customElements.get(tag) as (CustomElementConstructor & { observedAttributes?: string[] }) | undefined;
  if (!element) return [];
  const names = [...(element.observedAttributes ?? []), ...Object.keys(document.createElement(tag))];
  for (let proto = element.prototype; proto && proto !== HTMLElement.prototype; proto = Object.getPrototypeOf(proto))
    names.push(...Object.getOwnPropertyNames(proto));
  return names;
}

/** Tracked files that contain any of `names` as a whole word. */
function gitGrepFiles(names: readonly string[]): string[] {
  const patterns = names.flatMap((name) => ["-e", name]);
  try {
    return execFileSync("git", ["grep", "-l", "-w", "-F", ...patterns, "--", "."], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
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

/** HTML text nodes and labelling attribute values inside template markup, which `proseLiterals` cannot see. */
function templateTexts(line: string): string[] {
  if (/^\s*(\/\/|\*|\/\*|import )/.test(line)) return [];
  const nodes = [...line.matchAll(/>([^<>]+)</g)].map((match) => match[1]);
  const attributes = [...line.matchAll(/\b(?:aria-label|title|placeholder|alt)="([^"]*)"/g)].map((match) => match[1]);
  return [...nodes, ...attributes]
    .map((text) => text.replace(/\$\{[^}]*\}/g, " ").trim())
    .filter((text) => /^[A-Za-z][^=;{}()]*$/.test(text));
}

function retiredTextFindings(): string[] {
  const findings: string[] = [];
  for (const path of sourceFiles()) {
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((line, index) => {
        for (const text of [...proseLiterals(line), ...templateTexts(line)]) {
          const excepted = TEXT_EXCEPTIONS.some((entry) => entry.path === path && text.includes(entry.text));
          if (RETIRED_TEXT.test(text) && !excepted) findings.push(`${path}:${index + 1}: ${text}`);
        }
      });
  }
  return findings;
}

describe("retired vocabulary guard", () => {
  it("keeps retired words out of Console entry exports", () => {
    const names = [...Object.keys(consoleEntry), ...exportedTypeNames("src/console-entry.ts")];
    expect(retiredNames(names, [])).toEqual([]);
  });

  it("keeps retired words out of element tags, attributes and members", () => {
    registerAllStudioElements();
    const names = new Set<string>([...STUDIO_ELEMENT_TAGS, ...STUDIO_ELEMENT_TAGS.flatMap(publicMemberNames)]);
    expect(
      retiredNames(
        names,
        ALLOWED_MEMBERS.map((entry) => entry.name),
      ),
    ).toEqual([]);
    expect(RENAMED_MEMBERS.filter((name) => names.has(name))).toEqual([]);
  });

  it("keeps retired words out of dispatched event names", () => {
    expect(retiredNames(dispatchedEventNames(), [])).toEqual([]);
  });

  it("keeps renamed public names out of every tracked file except the rename records", () => {
    const files = gitGrepFiles(RENAMED_NAMES);
    expect(files.filter((path) => !RENAME_RECORDS.some((record) => record.path === path))).toEqual([]);
    const renames = readFileSync(RENAMES_DOC, "utf8");
    expect(RENAMED_NAMES.filter((name) => !renames.includes(`\`${name}\``))).toEqual([]);
  });

  it("keeps retired words out of user-facing strings except listed exceptions", () => {
    expect(retiredTextFindings()).toEqual([]);
  });

  it("lists only exceptions that still match source text", () => {
    const stale = TEXT_EXCEPTIONS.filter((entry) => !readFileSync(entry.path, "utf8").includes(entry.text));
    expect(stale).toEqual([]);
  });
});
