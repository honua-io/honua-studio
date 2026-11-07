import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
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
    response.end('event: error\ndata: {"message":"private diagnostic"}\n\n');
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
