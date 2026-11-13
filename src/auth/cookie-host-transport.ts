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

export function cookieRequestTarget(path: string, init?: RequestInit): string {
  const pathname = path.split("?")[0]!;
  if (/[^\x20-\x7e]|[\\#]/.test(path) || /%(?:2e|2f|5c)/i.test(pathname) || pathname.split("/").includes(".."))
    throw new Error("Cookie host transport rejected an unbounded URL.");
  let target: string;
  if (pathname === "/mcp" || pathname === "/api/mcp") {
    const request = JSON.parse(String(init?.body ?? "{}")) as {
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    const args = request.params?.arguments ?? {};
    const tool = request.params?.name;
    const layerList =
      tool === "honua_list_layers" &&
      Object.keys(args).every((key) => key === "offset" || key === "limit") &&
      Number.isSafeInteger(args.offset ?? 0) &&
      Number(args.offset ?? 0) >= 0 &&
      Number.isSafeInteger(args.limit ?? 100) &&
      Number(args.limit ?? 100) > 0 &&
      Number(args.limit ?? 100) <= 100;
    const styleRead =
      tool === "honua_get_style" &&
      Object.keys(args).every((key) => key === "styleId" || key === "includeStylesheet" || key === "encoding") &&
      (args.styleId === undefined || (typeof args.styleId === "string" && args.styleId.length <= 256)) &&
      (args.includeStylesheet === undefined || args.includeStylesheet === true) &&
      (args.encoding === undefined || args.encoding === "mapbox-style");
    const describe =
      tool === "honua_describe_layer" &&
      Object.keys(args).every((key) => key === "serviceId" || key === "layerId") &&
      typeof args.serviceId === "string" &&
      args.serviceId.length > 0 &&
      args.serviceId.length <= 256 &&
      Number.isSafeInteger(args.layerId) &&
      Number(args.layerId) >= 0;
    if (
      request.method !== "initialize" &&
      request.method !== "notifications/initialized" &&
      !(request.method === "tools/call" && (layerList || styleRead || describe))
    )
      throw new Error("The human catalog transport only permits layer discovery and style readback.");
    target = "/api/studio/catalog-mcp";
  } else if (
    (/^\/rest\/services\/(?:[^/]+\/)+FeatureServer\/\d+(?:\/query)?$/.test(pathname) ||
      /^\/ogc\/features\/collections\/[^/]+\/items$/.test(pathname)) &&
    (init?.method ?? "GET") === "GET"
  ) {
    target = `/api/studio/data${path}`;
  } else if (/^\/api\/v1\/admin\/metadata\/layers\/(0|[1-9]\d{0,8})\/suggest-style$/.test(pathname)) {
    const suggest = /^\/api\/v1\/admin\/metadata\/layers\/(0|[1-9]\d{0,8})\/suggest-style$/.exec(pathname);
    if ((init?.method ?? "GET").toUpperCase() !== "POST" || path !== pathname || !suggest) {
      throw new Error("Cookie host transport only permits bounded Studio requests.");
    }
    target = `/api/studio/layers/${suggest[1]}/suggest-style`;
  } else {
    if (
      !pathname.startsWith("/api/v1/studio/") &&
      !pathname.startsWith("/api/studio/v1/studio/") &&
      pathname !== "/api/health"
    )
      throw new Error("Cookie host transport only permits bounded Studio requests.");
    target = path.startsWith("/api/studio/") ? path : `/api/studio${path.slice(4)}`;
  }
  return target;
}
