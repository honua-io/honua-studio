import { execFileSync } from "node:child_process";
import { X509Certificate, createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  approverRealm,
  consoleOidcSettings,
  consoleUrl,
  identityOrigin,
  realmName,
  serverOrigin,
  studioComposeOverlay,
  studioSecretNames,
  validateImageLock,
} from "./lib/live-compose.mjs";
import { collectPlaywrightContexts, writeDiagnostic } from "./lib/live-diagnostics.mjs";
import { liveQualificationMode } from "./lib/live-qualification-mode.mjs";

const root = resolve(".tmp/live-compose");
const mode = liveQualificationMode();
const modelFree = mode === "oidc-lifecycle";
// The harness tests substitute a lock whose Console digest matches their synthetic artifact.
const lockPath = process.env.HONUA_LIVE_COMPOSE_IMAGES ?? new URL("./live-compose-images.json", import.meta.url);
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
// A digest-pinned shell for the identity file permissions: the Studio image base.
const shellImage = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8").match(
  /^FROM (\S+@sha256:[0-9a-f]{64})$/m,
)?.[1];
if (!shellImage) throw new Error("Dockerfile must start from a digest-pinned base image.");
validateImageLock(lock);

const mebibyte = 1024 * 1024;
const consoleBundleDirectory = resolve(".tmp/live-console-bundle");

function run(command, args, { cwd = root, maxBuffer = mebibyte, encoding = "utf8" } = {}) {
  try {
    return execFileSync(command, args, { cwd, maxBuffer, encoding, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(`${command} ${args[0]} failed with exit ${error.status}; private command output was withheld.`);
  }
}

function compose(args, options) {
  return run(
    "docker",
    [
      "compose",
      "--profile",
      "console",
      "-f",
      "compose.yaml",
      "-f",
      "compose.executor.yaml",
      "-f",
      "compose.executor.image.yaml",
      "-f",
      "compose.console.yaml",
      "-f",
      "compose.studio.json",
      ...args,
    ],
    options,
  );
}

function writePrivate(path, value) {
  writeFileSync(resolve(root, path), value, { mode: 0o640 });
}

function requireProviderKey() {
  if (!modelFree && !process.env.HONUA_LIVE_ANTHROPIC_API_KEY)
    throw new Error("HONUA_LIVE_ANTHROPIC_API_KEY is required.");
}

function check() {
  requireProviderKey();
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required to select the quickstart source.");
  appendFileSync(process.env.GITHUB_OUTPUT, `server_revision=${lock.server.revision}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `console_revision=${lock.console.revision}\n`);
}

/** Downloads the pinned official Console build and repackages its static root the way the nightly does. */
function fetchConsoleBundle() {
  const { revision, runId, artifact, artifactId, artifactDigest } = lock.console;
  const directory = consoleBundleDirectory;
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const metadata = JSON.parse(
    run("gh", ["api", `repos/honua-io/honua-console/actions/artifacts/${artifactId}`], { cwd: directory }),
  );
  if (
    metadata.name !== artifact ||
    String(metadata.workflow_run?.id) !== String(runId) ||
    metadata.workflow_run?.head_sha !== revision ||
    metadata.digest !== artifactDigest
  ) {
    throw new Error("The Console artifact does not match the pinned official build.");
  }
  const archive = run("gh", ["api", `repos/honua-io/honua-console/actions/artifacts/${artifactId}/zip`], {
    cwd: directory,
    maxBuffer: 1024 * mebibyte,
    encoding: "buffer",
  });
  if (`sha256:${createHash("sha256").update(archive).digest("hex")}` !== artifactDigest)
    throw new Error("The downloaded Console artifact does not match its pinned digest.");
  writeFileSync(resolve(directory, "artifact.zip"), archive);
  run("unzip", ["-q", "artifact.zip", "wwwroot/console/*", "-d", "artifact"], { cwd: directory });
  const web = resolve(directory, "artifact/wwwroot/console");
  const provenance = { repository: "honua-io/honua-console", workflow: "ci.yml", runId, sourceSha: revision, artifact };
  writeFileSync(resolve(web, "quickstart-build.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  run("zip", ["-q", "-r", "-X", "-D", resolve(directory, "console.zip"), "."], { cwd: web });
  const bundle = readFileSync(resolve(directory, "console.zip"));
  return {
    path: resolve(directory, "console.zip"),
    sha256: createHash("sha256").update(bundle).digest("hex"),
    index: createHash("sha256")
      .update(readFileSync(resolve(web, "index.html")))
      .digest("hex"),
  };
}

/** The customer package with the official Console, its HTTPS edge and server-mediated OIDC sign-in. */
function packageQuickstart(source, bundle) {
  run(
    "python3",
    [
      "scripts/docker/package_quickstart.py",
      "--server-image",
      lock.server.image,
      "--executor-image",
      lock.executor.image,
      "--worker-image",
      lock.server.image,
      "--console-bundle",
      bundle.path,
      "--console-bundle-sha256",
      bundle.sha256,
      "--version",
      lock.version,
      "--output",
      root,
    ],
    { cwd: source },
  );
  appendFileSync(
    resolve(root, ".env"),
    Object.entries(consoleOidcSettings())
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
  run("python3", ["quickstart.py", "--init-only", "--profile", "console"]);
  writeFileSync(
    resolve(consoleBundleDirectory, "served.json"),
    JSON.stringify({ sha256: bundle.sha256, index: bundle.index }),
  );
}

function prepare() {
  requireProviderKey();
  const source = resolve(process.env.HONUA_LIVE_SERVER_SOURCE ?? ".tmp/live-server-source");
  const revision = run("git", ["rev-parse", "HEAD"], { cwd: source }).trim();
  if (revision !== lock.server.revision) throw new Error("Quickstart source must match the locked server revision.");
  packageQuickstart(source, fetchConsoleBundle());
  for (const directory of ["identity/certs", "identity/realm"])
    mkdirSync(resolve(root, directory), { recursive: true });
  const password = randomBytes(32).toString("hex");
  const clientSecret = randomBytes(32).toString("hex");
  const secrets = {
    [studioSecretNames.oidcClient]: clientSecret,
    [studioSecretNames.operatorSigning]: randomBytes(32).toString("base64"),
  };
  if (!modelFree) secrets[studioSecretNames.provider] = process.env.HONUA_LIVE_ANTHROPIC_API_KEY;
  for (const [name, value] of Object.entries(secrets)) writePrivate(`secrets/${name}`, value);
  writePrivate("secrets/approver_password", password);
  writePrivate(`identity/realm/${realmName}.json`, JSON.stringify(approverRealm({ password, clientSecret })));
  writeFileSync(resolve(root, "compose.studio.json"), JSON.stringify(studioComposeOverlay(lock, { mode }), null, 2));
  createIdentityCertificate();
  // Node (readiness, identity and the browser step's REST checks) trusts exactly the realm and Console edge.
  writeFileSync(
    resolve(root, "identity/certs/node-trust.crt"),
    readFileSync(resolve(root, "identity/certs/kc.crt"), "utf8") +
      readFileSync(resolve(root, "secrets/console_tls_certificate"), "utf8"),
  );
  compose(["config", "--quiet"]);
  console.log("Customer quickstart prepared with immutable images and a dedicated OIDC test person.");
}

function createIdentityCertificate() {
  run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    `/CN=${new URL(identityOrigin).hostname}`,
    "-addext",
    `subjectAltName=DNS:${new URL(identityOrigin).hostname},DNS:localhost,IP:127.0.0.1`,
    "-keyout",
    "identity/certs/kc.key",
    "-out",
    "identity/certs/kc.crt",
  ]);
  run("chmod", ["644", "identity/certs/kc.crt"]);
  const trust = readFileSync("/etc/ssl/certs/ca-certificates.crt", "utf8");
  writeFileSync(
    resolve(root, "identity/certs/ca-bundle.crt"),
    trust + readFileSync(resolve(root, "identity/certs/kc.crt")),
  );
  run("chmod", ["644", "identity/certs/ca-bundle.crt"]);
  run("docker", [
    "run",
    "--rm",
    "-v",
    `${root}/identity:/identity`,
    "--entrypoint",
    "sh",
    shellImage,
    "-c",
    `chgrp -R 1001 /identity && chmod 640 /identity/certs/kc.key /identity/realm/${realmName}.json`,
  ]);
}

async function waitForReady(url) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (response.ok) return;
    } catch {}
    await new Promise((done) => setTimeout(done, 2000));
  }
  throw new Error(`Stack readiness timed out at ${new URL(url).pathname}.`);
}

async function initializeAdmission(apiKey) {
  const policy = {
    windowSeconds: 60,
    maxOperationSeconds: 180,
    deploymentAttempts: 12,
    actorAttempts: 12,
    cohortAttempts: 12,
    workflowAttempts: 12,
    deploymentConcurrency: 1,
    actorConcurrency: 1,
    cohortConcurrency: 1,
    workflowConcurrency: 1,
  };
  for (const action of ["initialize", "resume"]) {
    const response = await fetch(`${serverOrigin}/api/v1/operations/admin.ai.admission.${action}/submit`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ parameters: action === "initialize" ? { policy: JSON.stringify(policy) } : {} }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Admission ${action} returned HTTP ${response.status}.`);
    const { data } = await response.json();
    if (data?.status !== "Completed" || !data.auditId)
      throw new Error(`Admission ${action} did not complete with an audit receipt.`);
  }
}

async function observeConsoleBundle() {
  const expected = JSON.parse(readFileSync(resolve(consoleBundleDirectory, "served.json"), "utf8"));
  const served = Buffer.from(await (await fetch(`${consoleUrl}/index.html`)).arrayBuffer());
  if (createHash("sha256").update(served).digest("hex") !== expected.index)
    throw new Error("The Console edge does not serve the pinned official build.");
  const edge = JSON.parse(run("docker", ["inspect", compose(["ps", "-q", "console"]).trim()]))[0];
  return { ...lock.console, bundleSha256: expected.sha256, indexSha256: expected.index, webImage: edge.Config.Image };
}

async function recordRuntimeIdentity() {
  const observed = {};
  for (const [component, service] of [
    ["server", "honua"],
    ["executor", "compose-executor"],
  ]) {
    const containerId = compose(["ps", "-q", service]).trim();
    const container = JSON.parse(run("docker", ["inspect", containerId]))[0];
    const image = JSON.parse(run("docker", ["image", "inspect", lock[component].image]))[0];
    if (
      container.Image !== image.Id ||
      image.Config.Labels["org.opencontainers.image.revision"] !== lock[component].revision
    ) {
      throw new Error(`${component} runtime does not match the pinned candidate.`);
    }
    observed[component] = { ...lock[component], imageId: image.Id };
  }
  observed.console = await observeConsoleBundle();
  writeFileSync(
    resolve(".tmp/live-compose-identity.json"),
    JSON.stringify(
      {
        images: observed,
        studioRevision: process.env.GITHUB_SHA ?? run("git", ["rev-parse", "HEAD"], { cwd: process.cwd() }).trim(),
      },
      null,
      2,
    ),
  );
}

function spkiPin(certificatePath) {
  return createHash("sha256")
    .update(new X509Certificate(readFileSync(certificatePath)).publicKey.export({ type: "spki", format: "der" }))
    .digest("base64");
}

function exportBrowserEnvironment(apiKey) {
  const settings = {
    HONUA_LIVE_BASE_URL: `${serverOrigin}/api`,
    HONUA_LIVE_API_KEY: apiKey,
    HONUA_LIVE_CONSOLE_URL: consoleUrl,
    HONUA_LIVE_CONSOLE_SPKI: spkiPin(resolve(root, "secrets/console_tls_certificate")),
    HONUA_LIVE_APPROVER_IDP_ORIGIN: identityOrigin,
    HONUA_LIVE_APPROVER_IDP_SPKI: spkiPin(resolve(root, "identity/certs/kc.crt")),
    HONUA_LIVE_APPROVER_USERNAME: "studio-approver",
    HONUA_LIVE_APPROVER_PASSWORD: readFileSync(resolve(root, "secrets/approver_password"), "utf8"),
  };
  if (!process.env.GITHUB_ENV) throw new Error("GITHUB_ENV is required to hand private settings to the browser step.");
  for (const value of [settings.HONUA_LIVE_API_KEY, settings.HONUA_LIVE_APPROVER_PASSWORD]) {
    process.stdout.write(`::add-mask::${value}\n`);
  }
  appendFileSync(
    process.env.GITHUB_ENV,
    Object.entries(settings)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}

async function start() {
  compose(["up", "-d", "--wait", "--wait-timeout", "240"]);
  await waitForReady(`${serverOrigin}/healthz/ready`);
  await waitForReady(`${consoleUrl}/index.html`);
  await waitForReady(`${identityOrigin}/realms/${realmName}/.well-known/openid-configuration`);
  const apiKey = readFileSync(resolve(root, "secrets/honua_admin_password"), "utf8").trim();
  await recordRuntimeIdentity();
  await initializeAdmission(apiKey);
  exportBrowserEnvironment(apiKey);
  console.log("Customer stack is ready; admission is bounded and no model has been invoked.");
}

const action = process.argv[2];
if (action === "check") check();
else if (action === "prepare") prepare();
else if (action === "start") await start();
else if (action === "diagnostics") {
  collectPlaywrightContexts();
  writeDiagnostic(
    ".tmp/live-diagnostics/compose.log",
    compose(["logs", "--no-color", "honua", "console"], { maxBuffer: 64 * 1024 * 1024 }),
  );
  console.log("Redacted Playwright contexts and server/Console logs collected before teardown.");
} else if (action === "stop") compose(["down", "--volumes", "--remove-orphans"]);
else throw new Error("Expected check, prepare, start, diagnostics or stop.");
