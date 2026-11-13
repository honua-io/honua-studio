import type { CookieSessionAdapter } from "./types.js";

export function validCookieTransport(session: CookieSessionAdapter): boolean {
  const native = session.baseUrl === "/api/v1/studio";
  return (
    (native ? typeof session.fetchRequest === "function" : session.baseUrl === "/api/studio" && !!session.csrfToken) &&
    (native ? /^[A-Za-z0-9_-]{1,128}$/.test(session.environmentId) : !!session.environmentId) &&
    (native
      ? typeof session.principalId === "string" &&
        session.principalId.length > 0 &&
        session.principalId.length <= 4096 &&
        ![...session.principalId].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      : /^[A-Za-z0-9._:-]{1,256}$/.test(session.principalId ?? "")) &&
    Number.isFinite(Date.parse(session.expiresAt))
  );
}

/** Translate only targets already admitted by the bounded host-session router. */
function nativeRoute(target: string): string {
  if (target === "/api/studio/catalog-mcp") return "mcp";
  if (target.startsWith("/api/studio/data/")) return target.slice("/api/studio/data/".length);
  const suggest = /^\/api\/studio\/layers\/(\d+)\/suggest-style$/.exec(target);
  if (suggest) return `api/v1/admin/metadata/layers/${suggest[1]}/suggest-style`;
  return `api/${target.slice("/api/studio/".length)}`;
}

export function sendCookieRequest(
  session: CookieSessionAdapter,
  target: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.delete("authorization");
  headers.delete("x-api-key");
  if (session.baseUrl === "/api/v1/studio") {
    headers.delete("cookie");
    headers.delete("x-csrf-token");
    headers.delete("x-honua-csrf");
    headers.delete("x-honua-environment");
    headers.delete("x-honua-session-partition");
    if (!session.fetchRequest) throw new Error("Native host transport is unavailable.");
    return session.fetchRequest(nativeRoute(target), { ...init, headers });
  }
  headers.set("X-Honua-Environment", session.environmentId);
  headers.set("X-Honua-Session-Partition", session.principalId);
  if (!["GET", "HEAD", "OPTIONS"].includes((init?.method ?? "GET").toUpperCase()))
    headers.set("X-CSRF-Token", session.csrfToken!);
  return fetch(target, { ...init, headers, credentials: "same-origin", redirect: "error" });
}
