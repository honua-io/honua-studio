import type { HonuaStudioSessionAdapter } from "./types.js";

/** Any element exposing an (optionally unset) `.session` property — every `honua-studio-*` element. */
export interface HasOptionalSession {
  session?: HonuaStudioSessionAdapter;
}

/**
 * Resolves the effective session for a placeholder surface element:
 *
 * 1. its own `.session` property, if a host set one directly, else
 * 2. the nearest ancestor `<honua-studio-app>`'s `.session`.
 *
 * `closest()` walks ordinary (light) DOM only, by design — `<honua-studio-app>`
 * composes `<honua-studio-chat>` / `<honua-studio-canvas>` as real light-DOM
 * children (slotted into its shadow template, not created inside the shadow
 * root itself), so this resolves correctly for that default composition
 * while still respecting a host that assembled its own light-DOM tree in the
 * bare embed harness or a Blazor page, or a host that skips `<honua-studio-app>`
 * entirely and mounts a placeholder element on its own (which then simply
 * has no ancestor to inherit from, and stays anonymous until given a
 * `.session` directly — see docs/embed-session.md).
 */
export function resolveInjectedSession(element: Element & HasOptionalSession): HonuaStudioSessionAdapter | undefined {
  if (element.session) return element.session;
  const host = element.closest("honua-studio-app") as (Element & HasOptionalSession) | null;
  return host?.session ?? undefined;
}
