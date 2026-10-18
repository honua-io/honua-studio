import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Invoke under with-build-lock. Upstream source is a reviewed immutable input.
const revision = "66377f5dcf14275e205869f0c6549b2e86d7d879";
const source = resolve(process.argv[2] ?? "");
const root = resolve(".tmp/maputnik-host-build");
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: options.input === undefined ? "inherit" : ["pipe", "inherit", "inherit"], ...options });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
const head = spawnSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" });
if (head.status !== 0 || head.stdout.trim() !== revision)
  throw new Error("Expected the pinned Maputnik v3.1.0 source checkout.");
if (existsSync(root)) rmSync(root, { recursive: true });
mkdirSync(root, { recursive: true });
const archive = spawnSync("git", ["-C", source, "archive", revision], { maxBuffer: 64 * 1024 * 1024 });
if (archive.status !== 0) throw new Error("Could not export pinned upstream source.");
run("tar", ["-xf", "-", "-C", root], { input: archive.stdout });
cpSync("scripts/maputnik/host-store.ts", join(root, "src/libs/store/style-store-factory.ts"));
cpSync("scripts/maputnik/host-entry.jsx", join(root, "src/host-entry.jsx"));
writeFileSync(join(root, "src/config/tokens.json"), "{}\n");
// Keep rendering and authenticated resources in Honua's existing canvas.
const appPath = join(root, "src/components/App.tsx");
let app = readFileSync(appPath, "utf8");
app = app.replace("  updateFonts(urlTemplate: string) {", "  updateFonts(urlTemplate: string) { return;");
app = app.replace("  updateIcons(baseUrl: string) {", "  updateIcons(baseUrl: string) { return;");
app = app.replace(
  "    if (opts.addRevision) {",
  "    if (opts.initialLoad) this.revisionStore = new RevisionStore();\n    if (opts.addRevision || opts.initialLoad) {",
);
app = app.replace(
  '    window.addEventListener("keydown", this.handleKeyPress);',
  `    window.addEventListener("keydown", this.handleKeyPress);
    window.addEventListener("honua:style-fields", ((event: CustomEvent) => {
      const {sourceId, fields} = event.detail;
      if (typeof sourceId !== "string" || !Array.isArray(fields) || fields.length > 1000) return;
      const properties = Object.fromEntries(fields.filter(field => typeof field.name === "string").map(field => [field.name, field.type]));
      this.setState({vectorLayers: {...this.state.vectorLayers, [sourceId]: properties}});
    }) as EventListener);`,
);
writeFileSync(appPath, app);
const layoutPath = join(root, "src/components/AppLayout.tsx");
writeFileSync(
  layoutPath,
  readFileSync(layoutPath, "utf8").replace(
    "{this.props.map}",
    '<p role="note">Live preview appears in the Honua map canvas.</p>',
  ),
);
const layerPath = join(root, "src/components/LayerEditor.tsx");
writeFileSync(
  layerPath,
  readFileSync(layerPath, "utf8").replace(
    'this.props.vectorLayers[(this.props.layer as any)["source-layer"]]',
    'this.props.vectorLayers[(this.props.layer as any)["source-layer"] ?? (this.props.layer as any).source]',
  ),
);

const editorFactoryPath = join(root, "src/libs/codemirror-editor-factory.ts");
const editorFactory = readFileSync(editorFactoryPath, "utf8");
if (!editorFactory.includes("        if (update.docChanged) {")) throw new Error("Pinned CodeMirror input hook changed.");
writeFileSync(editorFactoryPath, editorFactory.replace("        if (update.docChanged) {", `        if (update.docChanged) {
          if (update.transactions.some(transaction => transaction.isUserEvent("input") || transaction.isUserEvent("delete")))
            window.dispatchEvent(new CustomEvent("honua:style-raw-input", {detail: {element: update.view.contentDOM}}));`));

writeFileSync(
  join(root, "vite.honua.config.mjs"),
  `import {defineConfig} from 'vite'; import react from '@vitejs/plugin-react'; export default defineConfig({publicDir:false,plugins:[react()],define:{global:'window'},build:{outDir:'dist-honua',cssCodeSplit:false,lib:{entry:'src/host-entry.jsx',name:'HonuaMaputnik',formats:['iife'],fileName:()=>'editor.js'},rollupOptions:{output:{inlineDynamicImports:true,assetFileNames:'[name][extname]'}}}});\n`,
);
run("npm", ["ci", "--ignore-scripts"], { cwd: root });
run(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "build", "--config", "vite.honua.config.mjs"], { cwd: root });
const output = resolve("public/maputnik");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
cpSync(join(root, "dist-honua"), output, { recursive: true });
cpSync(join(root, "LICENSE"), join(output, "LICENSE"));
const notices = ["Maputnik and bundled dependency license texts.\n"];
function collectNotices(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collectNotices(path);
    else if (/^(licen[cs]e|copying|notice)([._-].*)?$/i.test(entry.name)) {
      const text = readFileSync(path);
      if (text.length <= 1048576) notices.push(`\n--- ${path.slice(root.length + 1)} ---\n${text.toString("utf8")}\n`);
    }
  }
}
collectNotices(join(root, "node_modules"));
writeFileSync(join(output, "THIRD-PARTY-NOTICES.txt"), notices.join(""));

const css = readdirSync(output).filter((name) => name.endsWith(".css"));
writeFileSync(
  join(output, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; worker-src blob:; form-action 'none'; base-uri 'none'"><meta name="viewport" content="width=device-width,initial-scale=1">${css.map((name) => `<link rel="stylesheet" href="./${name}">`).join("")}</head><body><div id="app"></div><script src="./editor.js"></script></body></html>`,
);
const files = {};
for (const name of readdirSync(output).sort()) {
  const bytes = readFileSync(join(output, name));
  files[name] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
writeFileSync(
  join(output, "PROVENANCE.json"),
  `${JSON.stringify(
    {
      upstream: "https://github.com/maplibre/maputnik",
      version: "3.1.0",
      revision,
      patches: ["host-store.ts", "host-entry.jsx", "blank-provider-tokens", "opaque-frame-network-denied"],
      integration: Object.fromEntries(
        ["scripts/maputnik/host-store.ts", "scripts/maputnik/host-entry.jsx", "scripts/vendor-maputnik.mjs"].map(
          (path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")],
        ),
      ),
      files,
    },
    null,
    2,
  )}\n`,
);
