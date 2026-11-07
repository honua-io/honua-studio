#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const fixture = JSON.parse(readFileSync(process.env.STACK_FIXTURE, "utf8"));
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.STACK_COMMANDS, `${JSON.stringify({ command, args, cwd: process.cwd() })}\n`);
if (command === "git") process.stdout.write(fixture.sourceRevision);
if (command === "python3" && args[0].endsWith("package_quickstart.py")) {
  const root = args[args.indexOf("--output") + 1];
  mkdirSync(root, { recursive: true });
  for (const name of ["compose.yaml", "compose.executor.yaml", "compose.executor.image.yaml", "quickstart.py"])
    writeFileSync(resolve(root, name), "synthetic package\n");
}
if (command === "python3" && args.includes("--init-only")) {
  mkdirSync("secrets", { recursive: true });
  writeFileSync("secrets/honua_admin_password", "synthetic-admin-password");
  writeFileSync(".env", "COMPOSE_PROJECT_NAME=synthetic-only\n");
}
if (command === "openssl") {
  writeFileSync(args[args.indexOf("-keyout") + 1], "synthetic-key");
  writeFileSync(args[args.indexOf("-out") + 1], readFileSync("/etc/ssl/certs/ca-certificates.crt"));
}
if (command === "docker" && args[0] === "compose" && args.includes("ps")) process.stdout.write(args.at(-1));
if (command === "docker" && args[0] === "inspect") {
  const service = args[1];
  process.stdout.write(JSON.stringify([{ Image: fixture.wrongImage ? "wrong-image" : service }]));
}
if (command === "docker" && args[0] === "image") {
  const component = Object.keys(fixture.lock).find((name) => fixture.lock[name]?.image === args[2]);
  const service = { server: "honua", console: "console", executor: "compose-executor" }[component];
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
