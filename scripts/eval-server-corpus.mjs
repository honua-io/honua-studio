import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";

const baseUrl = process.env.HONUA_CORPUS_BASE_URL;
const apiKey = process.env.HONUA_CORPUS_API_KEY;
const authModule = process.env.HONUA_CORPUS_AUTH_MODULE;
const tokenProvider = authModule ? (await import(pathToFileURL(resolve(authModule)).href)).getAccessToken : undefined;
if (!baseUrl || (!apiKey && typeof tokenProvider !== "function"))
  throw new Error("Set HONUA_CORPUS_BASE_URL and HONUA_CORPUS_API_KEY for the owned disposable server.");
const endpoint = new URL(baseUrl);
if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) || endpoint.username || endpoint.password) {
  throw new Error(
    "This diagnostic runner requires an owned loopback server; it is not a shared deployment publish lane.",
  );
}
const apiBaseUrl = process.env.HONUA_CORPUS_API_BASE_URL ?? `${baseUrl.replace(/\/$/, "")}/api`;
if (new URL(apiBaseUrl).origin !== endpoint.origin)
  throw new Error("API and MCP must belong to the same owned server origin.");
const directory = resolve(process.env.HONUA_CORPUS_OUTPUT ?? ".tmp/server-corpus");
const modelName = process.env.HONUA_CORPUS_MODEL;
let model;
if (modelName) {
  const manifestPath = process.env.HONUA_CORPUS_SIGNING_MANIFEST;
  const provider = process.env.HONUA_CORPUS_PROVIDER;
  if (!manifestPath || !provider)
    throw new Error(
      "Live model requires an explicitly trusted HONUA_CORPUS_SIGNING_MANIFEST and HONUA_CORPUS_PROVIDER.",
    );
  const value = JSON.parse(await readFile(manifestPath, "utf8"));
  model = { model: modelName, provider, manifest: value.data?.transcriptSigning ?? value };
}
const sourcesPath = process.env.HONUA_CORPUS_SOURCES;
const sources = sourcesPath ? JSON.parse(await readFile(sourcesPath, "utf8")) : undefined;
if (sources !== undefined && !Array.isArray(sources))
  throw new Error("HONUA_CORPUS_SOURCES must name a JSON array of trusted source descriptors.");
const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom" });
try {
  const { runServerCorpus } = await server.ssrLoadModule("/src/evals/server-corpus.ts");
  const receipt = await runServerCorpus({
    baseUrl,
    apiBaseUrl,
    apiKey,
    tokenProvider,
    model,
    sources,
    runId: crypto.randomUUID(),
  });
  receipt.sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  receipt.sourceDirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/scorecard.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  const escapeHtml = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
    );
  await writeFile(
    `${directory}/scorecard.html`,
    `<!doctype html><meta charset="utf-8"><title>Studio server corpus</title><h1>${escapeHtml(receipt.mode)}</h1><p>${receipt.modelQualityEvaluated ? "Live model with verified transcripts." : "Scripted intents; model quality is not evaluated."} Release qualification is not evaluated.</p><table><tr><th>Scenario</th><th>Result</th><th>Cleanup</th></tr>${receipt.cases.map((entry) => `<tr><td>${escapeHtml(entry.taskId)}</td><td>${entry.passed ? "PASS" : "FAIL"}</td><td>${entry.cleanup.passed ? "PASS" : "FAIL"}</td></tr>`).join("")}</table><p><a href="scorecard.json">Raw requests, responses and typed scores</a></p>`,
  );
  console.log(
    `${receipt.cases.filter((entry) => entry.passed).length}/${receipt.cases.length} scenarios passed; ${directory}/scorecard.json`,
  );
  if (!receipt.passed) process.exitCode = 1;
} finally {
  await server.close();
}
