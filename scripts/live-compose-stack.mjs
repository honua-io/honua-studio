import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { approverRealm, studioComposeOverlay, validateImageLock } from "./lib/live-compose.mjs";

const root = resolve(".tmp/live-compose");
const lock = JSON.parse(readFileSync(new URL("./live-compose-images.json", import.meta.url), "utf8"));
validateImageLock(lock);

function run(command, args, cwd = root) {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(`${command} ${args[0]} failed with exit ${error.status}; private command output was withheld.`);
  }
}

function compose(args) {
  return run("docker", [
    "compose",
    "-f",
    "compose.yaml",
    "-f",
    "compose.executor.yaml",
    "-f",
    "compose.executor.image.yaml",
    "-f",
    "compose.studio.json",
    ...args,
  ]);
}

function writePrivate(path, value) {
  writeFileSync(resolve(root, path), value, { mode: 0o640 });
}

function prepare() {
  if (!process.env.HONUA_LIVE_ANTHROPIC_API_KEY) throw new Error("HONUA_LIVE_ANTHROPIC_API_KEY is required.");
  const source = resolve(process.env.HONUA_LIVE_SERVER_SOURCE ?? ".tmp/live-server-source");
  const revision = run("git", ["rev-parse", "HEAD"], source).trim();
  if (revision !== lock.server.revision) throw new Error("Quickstart source must match the locked server revision.");
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
      "--version",
      lock.version,
      "--output",
      root,
    ],
    source,
  );
  run("python3", ["quickstart.py", "--init-only"]);
  for (const directory of ["identity/certs", "identity/realm"])
    mkdirSync(resolve(root, directory), { recursive: true });
  const password = randomBytes(32).toString("hex");
  const clientSecret = randomBytes(32).toString("hex");
  writePrivate("secrets/anthropic_api_key", process.env.HONUA_LIVE_ANTHROPIC_API_KEY);
  writePrivate("secrets/oidc_client_secret", clientSecret);
  writePrivate("secrets/operator_signing_key", randomBytes(32).toString("base64"));
  writePrivate("secrets/approver_password", password);
  writePrivate("identity/realm/studio-live.json", JSON.stringify(approverRealm({ password, clientSecret })));
  writeFileSync(resolve(root, "compose.studio.json"), JSON.stringify(studioComposeOverlay(lock), null, 2));
  createIdentityCertificate();
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
    "/CN=host.docker.internal",
    "-addext",
    "subjectAltName=DNS:host.docker.internal,DNS:localhost,IP:127.0.0.1",
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
    "redis:7.4-alpine",
    "-c",
    "chgrp -R 1001 /identity && chmod 640 /identity/certs/kc.key /identity/realm/studio-live.json",
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
    const response = await fetch(`http://127.0.0.1:18080/api/v1/operations/admin.ai.admission.${action}/submit`, {
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

function recordRuntimeIdentity() {
  const observed = {};
  for (const [component, service] of [
    ["server", "honua"],
    ["console", "console"],
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
  writeFileSync(
    resolve(".tmp/live-compose-identity.json"),
    JSON.stringify(
      {
        images: observed,
        studioRevision: process.env.GITHUB_SHA ?? run("git", ["rev-parse", "HEAD"], process.cwd()).trim(),
      },
      null,
      2,
    ),
  );
}

function exportBrowserEnvironment(apiKey) {
  const settings = {
    HONUA_LIVE_BASE_URL: "http://127.0.0.1:18080/api",
    HONUA_LIVE_API_KEY: apiKey,
    HONUA_LIVE_CONSOLE_URL: "http://127.0.0.1:5174",
    HONUA_LIVE_CONSOLE_PROFILE_ID: "local-dev",
    HONUA_LIVE_APPROVER_IDP_ORIGIN: "https://host.docker.internal:8443",
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
  await waitForReady("http://127.0.0.1:18080/healthz/ready");
  await waitForReady("http://127.0.0.1:5174/version.json");
  await waitForReady("https://host.docker.internal:8443/realms/studio-live/.well-known/openid-configuration");
  const apiKey = readFileSync(resolve(root, "secrets/honua_admin_password"), "utf8").trim();
  await initializeAdmission(apiKey);
  recordRuntimeIdentity();
  exportBrowserEnvironment(apiKey);
  console.log("Customer stack is ready; admission is bounded and no model has been invoked.");
}

const action = process.argv[2];
if (action === "prepare") prepare();
else if (action === "start") await start();
else if (action === "stop") compose(["down", "--volumes", "--remove-orphans"]);
else throw new Error("Expected prepare, start or stop.");
