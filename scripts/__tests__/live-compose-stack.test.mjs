import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../live-compose-stack.mjs", import.meta.url));
const commandFixture = fileURLToPath(new URL("./fixtures/live-compose-command.mjs", import.meta.url));
const fetchFixture = new URL("./fixtures/live-compose-fetch.mjs", import.meta.url).href;
const lock = JSON.parse(readFileSync(new URL("../live-compose-images.json", import.meta.url), "utf8"));

function stackFixture(context, overrides = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), "studio-compose-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(resolve(directory, "commands"));
  mkdirSync(resolve(directory, "source"));
  for (const command of ["git", "python3", "openssl", "chmod", "docker"]) {
    const destination = resolve(directory, "commands", command);
    copyFileSync(commandFixture, destination);
    chmodSync(destination, 0o700);
  }
  const configuration = resolve(directory, "fixture.json");
  writeFileSync(configuration, JSON.stringify({ sourceRevision: lock.server.revision, lock, ...overrides }));
  const environment = {
    ...process.env,
    PATH: `${resolve(directory, "commands")}${delimiter}${process.env.PATH}`,
    STACK_FIXTURE: configuration,
    STACK_COMMANDS: resolve(directory, "commands.jsonl"),
    STACK_REQUESTS: resolve(directory, "requests.jsonl"),
    GITHUB_ENV: resolve(directory, "browser.env"),
    HONUA_LIVE_SERVER_SOURCE: resolve(directory, "source"),
    HONUA_LIVE_ANTHROPIC_API_KEY: "synthetic-provider-key",
    NODE_OPTIONS: `--import ${fetchFixture}`,
    GITHUB_SHA: "b".repeat(40),
  };
  const run = (action) =>
    spawnSync(process.execPath, [script, action], { cwd: directory, env: environment, encoding: "utf8" });
  const lines = (name) => {
    try {
      return readFileSync(resolve(directory, name), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  return {
    directory,
    environment,
    run,
    commands: () => lines("commands.jsonl"),
    requests: () => lines("requests.jsonl"),
  };
}

function prepareFixture(fixture) {
  const prepared = fixture.run("prepare");
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(prepared.stdout.includes("synthetic-provider-key"), false);
}

test("the CLI packages matching source, mounts private secrets, proves runtime identity and hands off private browser settings", (context) => {
  const fixture = stackFixture(context);
  prepareFixture(fixture);
  const root = resolve(fixture.directory, ".tmp/live-compose");
  assert.equal(statSync(resolve(root, "secrets/anthropic_api_key")).mode & 0o777, 0o640);
  assert.equal(readFileSync(resolve(root, "compose.studio.json"), "utf8").includes("synthetic-provider-key"), false);
  const started = fixture.run("start");
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.stdout.includes("synthetic-provider-key"), false);
  const settings = readFileSync(fixture.environment.GITHUB_ENV, "utf8");
  assert.match(settings, /HONUA_LIVE_APPROVER_USERNAME=studio-approver/);
  assert.match(settings, /HONUA_LIVE_API_KEY=synthetic-admin-password/);
  assert.match(settings, /HONUA_LIVE_APPROVER_IDP_SPKI=[A-Za-z0-9+/]{43}=/);
  assert.match(started.stdout, /::add-mask::synthetic-admin-password/);
  const password = readFileSync(resolve(root, "secrets/approver_password"), "utf8");
  assert.ok(started.stdout.indexOf(`::add-mask::${password}`) >= 0);
  assert.equal(settings.includes("synthetic-provider-key"), false);
  assert.equal(fixture.requests().length, 2);
  const initialization = fixture.requests()[0];
  assert.match(initialization.path, /admission.initialize\/submit$/);
  assert.equal(JSON.parse(initialization.body.parameters.policy).deploymentConcurrency, 1);
  const identity = JSON.parse(readFileSync(resolve(fixture.directory, ".tmp/live-compose-identity.json"), "utf8"));
  assert.equal(identity.images.server.revision, lock.server.revision);
  const packageCall = fixture.commands().find((call) => call.args[0] === "scripts/docker/package_quickstart.py");
  assert.equal(packageCall.args.at(-1), root);
  assert.equal(packageCall.cwd, fixture.environment.HONUA_LIVE_SERVER_SOURCE);
});

test("wrong quickstart source fails before packaging or creating secrets", (context) => {
  const fixture = stackFixture(context, { sourceRevision: "a".repeat(40) });
  assert.notEqual(fixture.run("prepare").status, 0);
  assert.deepEqual(
    fixture.commands().map((call) => call.command),
    ["git"],
  );
});

test("check selects the locked source without packaging or revealing provider credentials", (context) => {
  const fixture = stackFixture(context);
  fixture.environment.GITHUB_OUTPUT = resolve(fixture.directory, "outputs");
  const checked = fixture.run("check");
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.stdout.includes("synthetic-provider-key"), false);
  assert.equal(
    readFileSync(fixture.environment.GITHUB_OUTPUT, "utf8"),
    `server_revision=${lock.server.revision}\nconsole_revision=${lock.console.revision}\n`,
  );
  assert.equal(fixture.commands().length, 0);
});

test("a missing provider key fails before executing any command", (context) => {
  const fixture = stackFixture(context);
  fixture.environment.HONUA_LIVE_ANTHROPIC_API_KEY = undefined;
  assert.notEqual(fixture.run("prepare").status, 0);
  assert.equal(fixture.commands().length, 0);
});

for (const refusal of ["admissionRefused", "admissionFailed", "missingAudit"]) {
  test(`${refusal} prevents resume and browser credential handoff`, (context) => {
    const fixture = stackFixture(context, { [refusal]: true });
    prepareFixture(fixture);
    assert.notEqual(fixture.run("start").status, 0);
    assert.equal(fixture.requests().length, 1);
    assert.throws(() => readFileSync(fixture.environment.GITHUB_ENV), { code: "ENOENT" });
  });
}

for (const mismatch of ["wrongImage", "wrongRevision", "missingRevision"]) {
  test(`${mismatch} fails before admission is resumed or browser credentials are exported`, (context) => {
    const fixture = stackFixture(context, { [mismatch]: true });
    prepareFixture(fixture);
    assert.notEqual(fixture.run("start").status, 0);
    assert.equal(fixture.requests().length, 0);
    assert.throws(() => readFileSync(fixture.environment.GITHUB_ENV), { code: "ENOENT" });
  });
}

test("stop targets only the generated project with its saved Compose files", (context) => {
  const fixture = stackFixture(context);
  prepareFixture(fixture);
  assert.equal(fixture.run("stop").status, 0);
  const cleanup = fixture.commands().at(-1);
  assert.equal(cleanup.cwd, resolve(fixture.directory, ".tmp/live-compose"));
  assert.deepEqual(cleanup.args.slice(-3), ["down", "--volumes", "--remove-orphans"]);
  assert.equal(cleanup.args.includes("prune"), false);
});

test("diagnostics retain redacted logs and Playwright contexts before any stack teardown", (context) => {
  const fixture = stackFixture(context);
  prepareFixture(fixture);
  const output = resolve(fixture.directory, ".tmp/playwright-output/publish");
  mkdirSync(output, { recursive: true });
  writeFileSync(
    resolve(output, "error-context.md"),
    "Approval refused ?code=private-code&state=private-state synthetic-provider-key",
  );
  const collected = fixture.run("diagnostics");
  assert.equal(collected.status, 0, collected.stderr);
  const diagnostics = resolve(fixture.directory, ".tmp/live-diagnostics");
  const log = readFileSync(resolve(diagnostics, "compose.log"), "utf8");
  assert.match(log, /Missing approve grant/);
  assert.equal(log.includes("synthetic-token"), false);
  assert.equal(log.includes("synthetic-provider-key"), false);
  assert.equal(
    log.includes(readFileSync(resolve(fixture.directory, ".tmp/live-compose/secrets/approver_password"), "utf8")),
    false,
  );
  const snapshot = readFileSync(resolve(diagnostics, "playwright/publish/error-context.md"), "utf8");
  assert.match(snapshot, /Approval refused/);
  for (const secret of ["private-code", "private-state", "synthetic-provider-key"])
    assert.equal(snapshot.includes(secret), false);
  assert.equal(
    fixture.commands().some((call) => call.args.includes("down")),
    false,
  );
  assert.deepEqual(fixture.commands().at(-1).args.slice(-4), ["logs", "--no-color", "honua", "console"]);
});

test("diagnostics ignore an unreadable binary keyring while redacting readable text credentials", (context) => {
  const fixture = stackFixture(context);
  prepareFixture(fixture);
  const keyring = resolve(fixture.directory, ".tmp/live-compose/secrets/keyring.pfx");
  writeFileSync(keyring, Buffer.from([0, 255, 127]));
  chmodSync(keyring, 0);
  assert.throws(() => readFileSync(keyring), { code: "EACCES" });
  const result = fixture.run("diagnostics");
  assert.equal(result.status, 0, result.stderr);
  const log = readFileSync(resolve(fixture.directory, ".tmp/live-diagnostics/compose.log"), "utf8");
  assert.match(log, /Missing approve grant/);
  assert.equal(log.includes("synthetic-provider-key"), false);
});

test("diagnostics retain more than one MiB of Compose logs including the final failure", (context) => {
  const fixture = stackFixture(context, { oversizedLogs: true });
  prepareFixture(fixture);
  const result = fixture.run("diagnostics");
  assert.equal(result.status, 0, result.stderr);
  const log = readFileSync(resolve(fixture.directory, ".tmp/live-diagnostics/compose.log"), "utf8");
  assert.ok(log.length > 1024 * 1024);
  assert.match(log, /Missing approve grant/);
  assert.equal(log.includes("synthetic-provider-key"), false);
});
