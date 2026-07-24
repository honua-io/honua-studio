import type { AuthSession } from "./types.js";

/** Any element exposing an (optionally unset) `.auth` property — every `honua-studio-*` element. */
export interface HasOptionalAuth {
  auth?: AuthSession;
}

/**
 * Resolves the effective `AuthSession` for a placeholder surface element:
 *
 * 1. its own `.auth` property, if a host set one directly, else
 * 2. the nearest ancestor `<honua-studio-app>`'s `.auth` getter — always
 *    resolves to something (standalone OIDC at worst) once that element has
 *    connected, since `HonuaStudioAppElement` builds its `AuthSession`
 *    lazily on first access, not only on an explicit `.session` assignment.
 *
 * `closest()` walks ordinary (light) DOM only, by design — `<honua-studio-app>`
 * composes `<honua-studio-chat>` / `<honua-studio-canvas>` as real light-DOM
 * children (slotted into its shadow template, not created inside the shadow
 * root itself), so this resolves correctly for that default composition
 * while still respecting a host that assembled its own light-DOM tree in the
 * bare embed harness or a Blazor page, or a host that skips `<honua-studio-app>`
 * entirely and mounts a placeholder element on its own (which then simply
 * has no ancestor to inherit from, and stays anonymous — dispatching
 * `honua-studio-session-required` — until given an `.auth` directly; see
 * docs/embed-session.md).
 */
export function resolveInjectedAuth(element: Element & HasOptionalAuth): AuthSession | undefined {
  if (element.auth) return element.auth;
  const host = element.closest("honua-studio-app") as (Element & HasOptionalAuth) | null;
  return host?.auth ?? undefined;
}
