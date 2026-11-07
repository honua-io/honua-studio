import { createServer, request as httpRequest } from "node:http";
import { StringDecoder } from "node:string_decoder";

export const liveModelLimits = { provider: "opus", model: "claude-opus-5-5", maxTokens: 1024, maxCalls: 3 };

function usageObserver(call) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  return (chunk) => {
    pending = (pending + decoder.write(chunk)).replaceAll("\r\n", "\n");
    let boundary = pending.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      if (/^event: message_stop$/m.test(frame)) {
        try {
          const usage = JSON.parse(
            frame
              .split("\n")
              .find((line) => line.startsWith("data: "))
              .slice(6),
          );
          if (
            call.promptTokens !== undefined ||
            !Number.isInteger(usage.promptTokens) ||
            !Number.isInteger(usage.completionTokens)
          )
            call.invalidStream = true;
          else {
            call.promptTokens = usage.promptTokens;
            call.completionTokens = usage.completionTokens;
          }
        } catch {
          call.invalidStream = true;
        }
      }
      if (/^event: error$/m.test(frame)) call.invalidStream = true;
      boundary = pending.indexOf("\n\n");
    }
  };
}

async function boundedChatRequest(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1024 * 1024) throw new Error("Live chat body exceeds the harness limit.");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  const chat = JSON.parse(body);
  if (
    chat.provider !== liveModelLimits.provider ||
    chat.model !== liveModelLimits.model ||
    !Number.isInteger(chat.maxTokens) ||
    chat.maxTokens < 1 ||
    chat.maxTokens > liveModelLimits.maxTokens
  ) {
    throw new Error("Live chat must select Opus 5.5 with an explicit bounded maxTokens.");
  }
  return body;
}

function forward(request, response, origin, body, call) {
  const upstream = httpRequest(
    `${origin}${request.url}`,
    {
      method: request.method,
      headers: { ...request.headers, host: new URL(origin).host },
      timeout: 150_000,
    },
    (reply) => {
      if (call) {
        call.status = reply.statusCode;
        reply.on("data", usageObserver(call));
        reply.on("aborted", () => {
          call.invalidStream = true;
        });
      }
      response.writeHead(reply.statusCode, reply.headers);
      reply.pipe(response);
    },
  );
  upstream.on("timeout", () => upstream.destroy(new Error("Live upstream timed out.")));
  upstream.on("error", () => {
    if (call) call.invalidStream = true;
    if (!response.headersSent) response.writeHead(502);
    response.end("Live upstream request failed.");
  });
  response.on("close", () => {
    if (!response.writableFinished) upstream.destroy();
  });
  if (body !== undefined) upstream.end(body);
  else request.pipe(upstream);
}

function modelGuardHandler(origin, state) {
  return async (request, response) => {
    let path;
    try {
      path = decodeURIComponent(new URL(request.url, origin).pathname);
    } catch {
      state.rejectedCalls++;
      response.writeHead(400).end("Invalid qualification request path.");
      return;
    }
    if (!/^\/api\/v[\d.]+\/studio\/ai\/chat\/*$/i.test(path)) return forward(request, response, origin);
    let body;
    try {
      if (request.method !== "POST" || request.url !== "/api/v1/studio/ai/chat")
        throw new Error("Live chat requires the canonical POST route.");
      body = await boundedChatRequest(request);
    } catch {
      state.rejectedCalls++;
      response.writeHead(400).end("Live model request refused by the qualification guard.");
      return;
    }
    if (state.calls.length >= liveModelLimits.maxCalls) {
      state.rejectedCalls++;
      response.writeHead(429).end("Live model call budget exhausted; no upstream request was made.");
      return;
    }
    const call = { call: state.calls.length + 1 };
    state.calls.push(call);
    forward(request, response, origin, body, call);
  };
}

export async function startLiveModelGuard(origin) {
  const target = new URL(origin);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.pathname !== "/")
    throw new Error("The Compose guard requires a loopback server origin.");
  const state = { calls: [], rejectedCalls: 0 };
  const { calls } = state;
  const server = createServer(modelGuardHandler(target.origin, state));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
    evidence: () => ({
      limits: liveModelLimits,
      calls,
      rejectedCalls: state.rejectedCalls,
      promptTokens: calls.reduce((total, call) => total + (call.promptTokens ?? 0), 0),
      completionTokens: calls.reduce((total, call) => total + (call.completionTokens ?? 0), 0),
    }),
    assertQualified: () => {
      if (state.rejectedCalls) throw new Error("Live model guard refused requests; qualification failed.");
      if (
        !calls.length ||
        calls.some(
          (call) =>
            call.status !== 200 ||
            call.invalidStream ||
            !Number.isInteger(call.promptTokens) ||
            call.promptTokens < 1 ||
            !Number.isInteger(call.completionTokens) ||
            call.completionTokens < 0 ||
            call.completionTokens > liveModelLimits.maxTokens,
        )
      ) {
        throw new Error("Every live model call must complete with valid provider token usage.");
      }
    },
  };
}
