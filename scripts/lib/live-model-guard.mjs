import { createServer, request as httpRequest } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { SseFrameParser } from "../../src/chat/sse-parser.ts";
import { diagnosticRedactor } from "./live-diagnostics.mjs";
import { attachRealtimeProxy } from "./live-realtime-proxy.mjs";

const turnCalls = { chat: 1, composition: 2 };
export const liveModelLimits = {
  provider: "opus",
  model: "claude-opus-5-5",
  maxTokens: 1024,
  maxCalls: turnCalls.chat + turnCalls.composition,
  turnCalls,
};

function recordUsageFrame(call, frame, redact) {
  if (frame.event === "error") {
    call.invalidStream = true;
    call.errors ??= [];
    try {
      call.errors.push({ event: frame.event, data: JSON.parse(redact(frame.data)) });
    } catch {
      call.errors.push({ event: frame.event, data: redact(frame.data) });
    }
  }
  if (frame.event !== "message_stop") return;
  try {
    const usage = JSON.parse(frame.data);
    if (
      call.promptTokens !== undefined ||
      !Number.isInteger(usage.promptTokens) ||
      !Number.isInteger(usage.completionTokens)
    ) {
      call.invalidStream = true;
      return;
    }
    call.promptTokens = usage.promptTokens;
    call.completionTokens = usage.completionTokens;
  } catch {
    call.invalidStream = true;
  }
}

function usageObserver(call, redact) {
  const decoder = new StringDecoder("utf8");
  const parser = new SseFrameParser();
  return (chunk) => {
    for (const frame of parser.push(decoder.write(chunk))) recordUsageFrame(call, frame, redact);
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

function forward(request, response, origin, { body, call, approval, redact, sockets } = {}) {
  const upstream = httpRequest(
    `${origin}${request.url}`,
    {
      method: request.method,
      headers: { ...request.headers, host: new URL(origin).host, "accept-encoding": "identity" },
      timeout: 150_000,
      agent: false,
    },
    (reply) => {
      reply.on("error", () => {
        if (call) call.invalidStream = true;
        response.end();
      });
      if (call) {
        call.status = reply.statusCode;
        reply.on("data", usageObserver(call, redact));
        reply.on("aborted", () => {
          call.invalidStream = true;
        });
      }
      if (approval) observeApproval(reply, approval, redact);
      response.writeHead(reply.statusCode, reply.headers);
      reply.pipe(response);
    },
  );
  upstream.on("socket", (socket) => trackSocket(sockets, socket));
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

function observeApproval(reply, approval, redact) {
  approval.status = reply.statusCode;
  const chunks = [];
  reply.on("data", (chunk) => chunks.push(chunk));
  reply.on("end", () => {
    const body = redact(Buffer.concat(chunks).toString("utf8"));
    try {
      approval.body = JSON.parse(body);
    } catch {
      approval.body = body;
    }
  });
  reply.on("aborted", () => {
    approval.interrupted = true;
  });
}

function trackSocket(sockets, socket) {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
}

function modelGuardHandler(origin, state, redact, sockets) {
  return async (request, response) => {
    let path;
    try {
      if (!request.url.startsWith("/") || request.url.startsWith("//")) throw new Error("Invalid raw request path.");
      path = decodeURIComponent(new URL(request.url, origin).pathname);
    } catch {
      state.rejectedCalls++;
      response.writeHead(400).end("Invalid qualification request path.");
      return;
    }
    if (!/^\/api\/v[\d.]+\/studio\/ai\/chat\/*$/i.test(path)) {
      let approval;
      if (/^\/api\/v1\/admin\/proposals\/[^/]+(?:\/approve)?$/.test(path)) {
        approval = { method: request.method, path };
        state.approvals.push(approval);
      }
      return forward(request, response, origin, { approval, redact, sockets });
    }
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
    forward(request, response, origin, { body, call, redact, sockets });
  };
}

export async function startLiveModelGuard(origin, { host = "127.0.0.1", port = 0 } = {}) {
  const target = new URL(origin);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.pathname !== "/")
    throw new Error("The Compose guard requires a loopback server origin.");
  const state = { calls: [], approvals: [], rejectedCalls: 0 };
  const { calls } = state;
  const sockets = new Set();
  const server = createServer(modelGuardHandler(target.origin, state, diagnosticRedactor(), sockets));
  server.on("connection", (socket) => trackSocket(sockets, socket));
  attachRealtimeProxy(server, { origin: target.origin, state, trackSocket: (socket) => trackSocket(sockets, socket) });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  let closing;
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      closing ??= new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Live guard shutdown exceeded one second.")), 1000);
        server.close(() => {
          clearTimeout(timeout);
          resolve();
        });
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
    evidence: () => ({
      limits: liveModelLimits,
      calls,
      approvals: state.approvals,
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
