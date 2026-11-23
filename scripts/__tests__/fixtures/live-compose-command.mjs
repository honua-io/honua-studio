#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const fixture = JSON.parse(readFileSync(process.env.STACK_FIXTURE, "utf8"));
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.STACK_COMMANDS, `${JSON.stringify({ command, args, cwd: process.cwd() })}\n`);
if (command === "git") process.stdout.write(fixture.sourceRevision);
if (command === "gh" && args[1].endsWith("/zip")) process.stdout.write(fixture.consoleArtifact);
else if (command === "gh") {
  const { console: bundle } = fixture.lock;
  process.stdout.write(
    JSON.stringify({
      name: bundle.artifact,
      digest: bundle.artifactDigest,
      workflow_run: { id: bundle.runId, head_sha: fixture.wrongConsoleRevision ? "c".repeat(40) : bundle.revision },
    }),
  );
}
if (command === "unzip") {
  mkdirSync("artifact/wwwroot/console", { recursive: true });
  writeFileSync("artifact/wwwroot/console/index.html", fixture.consoleIndex);
}
if (command === "zip") writeFileSync(args[4], "synthetic console bundle");
if (command === "python3" && args[0].endsWith("package_quickstart.py")) {
  const root = args[args.indexOf("--output") + 1];
  mkdirSync(root, { recursive: true });
  for (const name of [
    "compose.yaml",
    "compose.executor.yaml",
    "compose.executor.image.yaml",
    "compose.console.yaml",
    "quickstart.py",
  ])
    writeFileSync(resolve(root, name), "synthetic package\n");
}
if (command === "python3" && args.includes("--init-only")) {
  mkdirSync("secrets", { recursive: true });
  writeFileSync("secrets/honua_admin_password", "synthetic-admin-password");
  writeFileSync("secrets/console_tls_certificate", readFileSync("/etc/ssl/certs/ca-certificates.crt"));
  appendFileSync(".env", "COMPOSE_PROJECT_NAME=synthetic-only\n");
}
if (command === "openssl") {
  writeFileSync(args[args.indexOf("-keyout") + 1], "synthetic-key");
  writeFileSync(args[args.indexOf("-out") + 1], readFileSync("/etc/ssl/certs/ca-certificates.crt"));
}
if (command === "docker" && args[0] === "compose" && args.includes("ps")) process.stdout.write(args.at(-1));
if (command === "docker" && args[0] === "inspect") {
  const service = args[1];
  const image = fixture.wrongImage ? "wrong-image" : service;
  process.stdout.write(JSON.stringify([{ Image: image, Config: { Image: `synthetic-${service}-image` } }]));
}
if (command === "docker" && args[0] === "image") {
  const component = Object.keys(fixture.lock).find((name) => fixture.lock[name]?.image === args[2]);
  const service = { server: "honua", executor: "compose-executor" }[component];
  const revision = fixture.missingRevision
    ? undefined
    : fixture.wrongRevision
      ? "a".repeat(40)
      : fixture.lock[component].revision;
  process.stdout.write(
    JSON.stringify([{ Id: service, Config: { Labels: { "org.opencontainers.image.revision": revision } } }]),
  );
}

if (command === "docker" && args[0] === "compose" && args.includes("logs")) {
  if (fixture.oversizedLogs) process.stdout.write("x".repeat(2 * 1024 * 1024));
  process.stdout.write("honua | Missing approve grant; Bearer synthetic-token\n");
  process.stdout.write(`console | ${readFileSync("secrets/approver_password", "utf8")}\n`);
  process.stdout.write(`honua | ${readFileSync("secrets/anthropic_api_key", "utf8")}\n`);
}
