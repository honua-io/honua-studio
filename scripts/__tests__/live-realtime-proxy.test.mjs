import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import { startLiveModelGuard } from "../lib/live-model-guard.mjs";

async function realtimeFixture(context) {
  const upgrades = [];
  const sockets = new Set();
  const upstream = createServer((_, response) => response.writeHead(401).end());
  upstream.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  upstream.on("upgrade", (request, socket, head) => {
    upgrades.push({ path: request.url, head: head.toString(), headers: request.headers });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nserver-head");
    socket.write(`echo:${head}`);
    socket.on("data", (chunk) => socket.write(`echo:${chunk}`));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const guard = await startLiveModelGuard(`http://127.0.0.1:${upstream.address().port}`);
  context.after(async () => {
    await guard.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => upstream.close(resolve));
  });
  return { guard, upgrades, upstream };
}

function exchange(origin, path, expected) {
  return new Promise((resolve, reject) => {
    const socket = connect(new URL(origin).port, "127.0.0.1");
    let received = "";
    const deadline = setTimeout(() => {
      socket.destroy();
      reject(new Error("Realtime upgrade did not complete within one second."));
    }, 1000);
    socket.once("error", reject);
    socket.once("close", () => clearTimeout(deadline));
    socket.once("connect", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAuthorization: Bearer synthetic-person\r\n\r\nclient-head`,
      );
    });
    socket.on("data", (chunk) => {
      received += chunk;
      if (!received.includes(expected)) return;
      clearTimeout(deadline);
      resolve({ socket, received });
    });
  });
}

test("the observer relays the realtime upgrade, credentials and buffered bytes in both directions", async (context) => {
  const { guard, upgrades } = await realtimeFixture(context);
  const { socket, received } = await exchange(guard.origin, "/hubs/admin?id=synthetic", "echo:client-head");
  context.after(() => socket.destroy());
  assert.match(received, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.match(received, /server-head/);
  assert.equal(upgrades.length, 1);
  assert.equal(upgrades[0].path, "/hubs/admin?id=synthetic");
  assert.equal(upgrades[0].headers.authorization, "Bearer synthetic-person");
  const relayed = once(socket, "data", { signal: AbortSignal.timeout(1000) });
  socket.write("after-upgrade");
  assert.equal((await relayed)[0].toString(), "echo:after-upgrade");
  assert.equal(guard.evidence().calls.length, 0);
  const closed = new Promise((resolve) => socket.once("close", resolve));
  await guard.close();
  await closed;
});

test("upgrades cannot bypass the model guard or reach another upstream route", async (context) => {
  const { guard, upgrades } = await realtimeFixture(context);
  for (const path of ["/api/v1/studio/ai/chat", "//elsewhere/hubs/admin", "/other"]) {
    const { socket, received } = await exchange(guard.origin, path, "\r\n\r\n");
    socket.destroy();
    assert.match(received, /^HTTP\/1\.1 400 Bad Request\r\n/);
  }
  assert.equal(upgrades.length, 0);
  assert.equal(guard.evidence().rejectedCalls, 3);
  assert.throws(() => guard.assertQualified(), /guard refused requests/);
});

test("a rejected upstream handshake returns its status instead of leaving the client waiting", async (context) => {
  const { guard, upstream } = await realtimeFixture(context);
  upstream.removeAllListeners("upgrade");
  upstream.on("upgrade", (_, socket) => {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  const { socket, received } = await exchange(guard.origin, "/hubs/admin", "\r\n\r\n");
  socket.destroy();
  assert.match(received, /^HTTP\/1\.1 401 Unauthorized\r\n/);
});
