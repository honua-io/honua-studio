import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startLiveModelGuard } from "../lib/live-model-guard.mjs";

async function fixture(context, respond) {
  const requests = [];
  const upstream = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, body, headers: request.headers });
    respond(response);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const guard = await startLiveModelGuard(`http://127.0.0.1:${upstream.address().port}`);
  context.after(async () => {
    await guard.close();
    await new Promise((resolve) => upstream.close(resolve));
  });
  const chat = (overrides = {}) =>
    fetch(`${guard.origin}/api/v1/studio/ai/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "synthetic-private-key" },
      body: JSON.stringify({ provider: "opus", model: "claude-opus-5-5", maxTokens: 1024, messages: [], ...overrides }),
    });
  return { guard, requests, chat };
}

function completedStream(response) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write('event: message_start\ndata: {"model":"claude-opus-5-5"}\n\nevent: message_stop\nda');
  response.end('ta: {"promptTokens":37,"completionTokens":2}\n\n');
}

test("shutdown closes idle clients and active upstream streams within a bounded time", async (context) => {
  let upstreamResponse;
  const { guard, chat } = await fixture(context, (response) => {
    upstreamResponse = response;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('event: message_start\ndata: {"model":"claude-opus-5-5"}\n\n');
  });
  const idle = connect(new URL(guard.origin).port, "127.0.0.1");
  await new Promise((resolve) => idle.once("connect", resolve));
  const reply = await chat();
  const consumed = reply.text().catch(() => {});
  const upstreamClosed = new Promise((resolve) => upstreamResponse.once("close", resolve));
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error("Guard shutdown hung with open sockets.")), 2000);
  });
  try {
    await Promise.race([guard.close(), deadline]);
    await Promise.race([upstreamClosed, deadline]);
    assert.equal(guard.evidence().calls.length, 1);
    assert.equal(guard.evidence().calls[0].invalidStream, true);
  } finally {
    clearTimeout(timeout);
    idle.destroy();
    upstreamResponse.end();
    await consumed;
  }
});

test("the qualification CLI persists evidence and redacted contexts on browser failure and cancellation", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "studio-qualification-shutdown-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const commands = join(directory, "commands");
  mkdirSync(commands);
  const npm = join(commands, "npm");
  writeFileSync(
    npm,
    `#!/usr/bin/env node
const { connect } = require("node:net");
const socket = connect(new URL(process.env.HONUA_LIVE_BASE_URL).port, "127.0.0.1");
socket.once("connect", () => {
  console.log("SYNTHETIC_BROWSER_READY");
  if (process.env.SYNTHETIC_BROWSER_MODE === "failure") process.exit(7);
  if (process.env.SYNTHETIC_BROWSER_MODE === "unqualified") process.exit(0);
});
`,
  );
  chmodSync(npm, 0o700);
  for (const mode of ["failure", "unqualified", "SIGINT", "SIGTERM"]) {
    await context.test(mode, { timeout: 5000 }, async () => {
      const cwd = join(directory, mode);
      mkdirSync(join(cwd, ".tmp/playwright-output/publish"), { recursive: true });
      writeFileSync(
        join(cwd, ".tmp/playwright-output/publish/error-context.md"),
        "Console callback timed out ?code=synthetic-private-code&state=synthetic-private-state",
      );
      const child = spawn(process.execPath, [fileURLToPath(new URL("../qualify-live-compose.mjs", import.meta.url))], {
        cwd,
        env: { ...process.env, PATH: `${commands}${delimiter}${process.env.PATH}`, SYNTHETIC_BROWSER_MODE: mode },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let errors = "";
      let signaled = false;
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (mode.startsWith("SIG") && !signaled && output.includes("SYNTHETIC_BROWSER_READY")) {
          signaled = true;
          child.kill(mode);
        }
      });
      child.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      try {
        const code = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        assert.equal(code, { failure: 7, unqualified: 1, SIGINT: 130, SIGTERM: 143 }[mode], errors);
        const usage = JSON.parse(readFileSync(join(cwd, ".tmp/live-model-usage.json"), "utf8"));
        assert.equal(usage.calls.length, 0);
        assert.equal(usage.limits.maxCalls, 3);
        assert.equal(usage.limits.maxTokens, 1024);
        assert.match(output, /Live model usage:/);
        const snapshot = readFileSync(join(cwd, ".tmp/live-diagnostics/playwright/publish/error-context.md"), "utf8");
        assert.match(snapshot, /Console callback timed out/);
        assert.equal(snapshot.includes("synthetic-private"), false);
      } finally {
        child.kill("SIGKILL");
      }
    });
  }
});

test("a single guard caps concurrent calls across clients and records only provider token receipts", async (context) => {
  const { guard, requests, chat } = await fixture(context, completedStream);
  const replies = await Promise.all(Array.from({ length: 5 }, () => chat()));
  await Promise.all(replies.map((reply) => reply.text()));
  assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 200, 200, 429, 429]);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].headers["x-api-key"], "synthetic-private-key");
  assert.equal(JSON.parse(requests[0].body).maxTokens, 1024);
  const evidence = guard.evidence();
  assert.equal(evidence.calls.length, 3);
  assert.equal(evidence.rejectedCalls, 2);
  assert.deepEqual(evidence.calls[0], { call: 1, status: 200, promptTokens: 37, completionTokens: 2 });
  assert.equal(evidence.promptTokens, 111);
  assert.equal(evidence.completionTokens, 6);
  assert.equal(JSON.stringify(evidence).includes("synthetic-private-key"), false);
  assert.throws(() => guard.assertQualified(), /refused/);
});

test("oversized or unapproved requests never reach the upstream", async (context) => {
  const { guard, requests, chat } = await fixture(context, completedStream);
  for (const override of [
    { maxTokens: 1025 },
    { maxTokens: undefined },
    { model: "unapproved" },
    { provider: "other" },
  ]) {
    assert.equal((await chat(override)).status, 400);
  }
  assert.equal(requests.length, 0);
  assert.throws(() => guard.assertQualified(), /refused/);
});

test("missing usage and failed provider responses cannot qualify", async (context) => {
  const { guard, chat } = await fixture(context, (response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('event: error\ndata: {"message":"Token refused","token":"private diagnostic"}\n\n');
  });
  await (await chat()).text();
  assert.throws(() => guard.assertQualified(), /usage/);
  assert.equal(JSON.stringify(guard.evidence()).includes("private diagnostic"), false);
});

test("route aliases cannot evade model admission", async (context) => {
  const { guard, requests } = await fixture(context, completedStream);
  for (const path of [
    "//api/v1/studio/ai/chat",
    "/api/v1/studio/ai/chat?extra=1",
    "/api/v1/studio/ai/chat/",
    "/API/v1/STUDIO/ai/chat",
    "/api/v1.0/studio/ai/chat",
  ]) {
    const reply = await fetch(`${guard.origin}${path}`, { method: "POST", body: "{}" });
    assert.equal(reply.status, 400);
  }
  assert.equal(requests.length, 0);
});

test("provider HTTP errors consume a call and are never retried or accepted", async (context) => {
  const { guard, requests, chat } = await fixture(context, (response) => response.writeHead(503).end());
  assert.equal((await chat()).status, 503);
  assert.equal(requests.length, 1);
  assert.equal(guard.evidence().calls[0].status, 503);
  assert.throws(() => guard.assertQualified(), /usage/);
});

test("an interrupted upstream reply leaves evidence and the guard can serve the next request", async (context) => {
  let interrupted;
  const { guard, chat } = await fixture(context, (response) => {
    if (interrupted) {
      response.writeHead(200).end("ready");
      return;
    }
    interrupted = response;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('event: message_start\ndata: {"model":');
  });
  const reply = await chat();
  assert.equal(reply.status, 200);
  interrupted.socket.destroy();
  await reply.text();
  assert.equal(guard.evidence().calls.length, 1);
  assert.equal(guard.evidence().calls[0].invalidStream, true);
  assert.throws(() => guard.assertQualified(), /usage/);
  const later = await fetch(`${guard.origin}/api/v1/studio/ai/capabilities`);
  assert.equal(later.status, 200);
  assert.equal(await later.text(), "ready");
});

test("a completed turn qualifies with usage while ordinary API traffic consumes no model budget", async (context) => {
  const { guard, chat } = await fixture(context, completedStream);
  await (await fetch(`${guard.origin}/api/v1/studio/ai/capabilities`)).text();
  await (await chat()).text();
  assert.equal(guard.evidence().calls.length, 1);
  assert.doesNotThrow(() => guard.assertQualified());
});

test("approval responses retain status and redacted problem details without request credentials", async (context) => {
  const { guard } = await fixture(context, (response) => {
    response.writeHead(403, { "content-type": "application/problem+json" });
    response.end(
      JSON.stringify({ title: "Approval refused", detail: "Missing approve grant", token: "private-token" }),
    );
  });
  const response = await fetch(`${guard.origin}/api/v1/admin/proposals/test-proposal/approve`, {
    method: "POST",
    headers: { authorization: "Bearer private-bearer" },
  });
  await response.text();
  assert.deepEqual(guard.evidence().approvals, [
    {
      method: "POST",
      path: "/api/v1/admin/proposals/test-proposal/approve",
      status: 403,
      body: { title: "Approval refused", detail: "Missing approve grant", token: "[REDACTED]" },
    },
  ]);
  assert.equal(JSON.stringify(guard.evidence()).includes("private-bearer"), false);
  assert.equal(guard.evidence().calls.length, 0);
});

test("SSE error frames keep the error code and redact credentials across split chunks", async (context) => {
  const { guard, chat } = await fixture(context, (response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("event: error\nda");
    response.end(
      'ta: {"code":"tool_schema_rejected","message":"Authorization: Bearer private-bearer","apiKey":"private-key"}\n\n',
    );
  });
  await (await chat()).text();
  assert.deepEqual(guard.evidence().calls[0].errors, [
    {
      event: "error",
      data: {
        code: "tool_schema_rejected",
        message: "Authorization: Bearer [REDACTED]",
        apiKey: "[REDACTED]",
      },
    },
  ]);
  assert.throws(() => guard.assertQualified(), /usage/);
});
