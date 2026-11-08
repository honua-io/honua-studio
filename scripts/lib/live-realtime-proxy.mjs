import { request as httpRequest } from "node:http";

function rejectUpgrade(socket, status = "400 Bad Request") {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function writeUpgradeResponse(socket, reply) {
  const headers = [`HTTP/${reply.httpVersion} ${reply.statusCode} ${reply.statusMessage}`];
  for (let index = 0; index < reply.rawHeaders.length; index += 2) {
    headers.push(`${reply.rawHeaders[index]}: ${reply.rawHeaders[index + 1]}`);
  }
  socket.write(`${headers.join("\r\n")}\r\n\r\n`);
}

export function attachRealtimeProxy(server, { origin, state, trackSocket }) {
  server.on("upgrade", (request, client, head) => {
    if (
      request.method !== "GET" ||
      request.url.split("?")[0] !== "/hubs/admin" ||
      request.headers.upgrade?.toLowerCase() !== "websocket"
    ) {
      state.rejectedCalls++;
      rejectUpgrade(client);
      return;
    }
    const upstream = httpRequest(`${origin}${request.url}`, {
      headers: { ...request.headers, host: new URL(origin).host },
      timeout: 150_000,
      agent: false,
    });
    upstream.on("socket", trackSocket);
    upstream.on("upgrade", (reply, remote, remoteHead) => {
      remote.on("error", () => client.destroy());
      client.once("close", () => remote.destroy());
      remote.once("close", () => client.destroy());
      writeUpgradeResponse(client, reply);
      if (remoteHead.length) client.write(remoteHead);
      if (head.length) remote.write(head);
      client.pipe(remote).pipe(client);
    });
    upstream.on("response", (reply) => {
      reply.resume();
      rejectUpgrade(client, `${reply.statusCode} ${reply.statusMessage}`);
    });
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.once("close", () => upstream.destroy());
    upstream.end();
  });
}
