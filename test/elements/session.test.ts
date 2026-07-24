// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { resolveInjectedSession } from "../../src/elements/session.js";
import type { HonuaStudioSessionAdapter } from "../../src/elements/types.js";

function fakeSession(baseUrl: string): HonuaStudioSessionAdapter {
  return {
    baseUrl,
    getSnapshot: () => ({ status: "authenticated", subject: baseUrl }),
    getAccessToken: async () => "token",
    onChange: () => ({ remove: () => {} }),
  };
}

describe("elements/session resolveInjectedSession", () => {
  it("prefers the element's own session over an ancestor's", () => {
    const app = document.createElement("honua-studio-app") as HTMLElement & { session?: HonuaStudioSessionAdapter };
    app.session = fakeSession("https://app-session.example");
    const child = document.createElement("honua-studio-chat") as HTMLElement & { session?: HonuaStudioSessionAdapter };
    child.session = fakeSession("https://own-session.example");
    app.appendChild(child);

    expect(resolveInjectedSession(child)?.baseUrl).toBe("https://own-session.example");
  });

  it("falls back to the nearest honua-studio-app ancestor's session", () => {
    const app = document.createElement("honua-studio-app") as HTMLElement & { session?: HonuaStudioSessionAdapter };
    app.session = fakeSession("https://inherited.example");
    const wrapper = document.createElement("div");
    const child = document.createElement("honua-studio-canvas") as HTMLElement & {
      session?: HonuaStudioSessionAdapter;
    };
    app.appendChild(wrapper);
    wrapper.appendChild(child);

    expect(resolveInjectedSession(child)?.baseUrl).toBe("https://inherited.example");
  });

  it("returns undefined with no own session and no honua-studio-app ancestor", () => {
    const orphan = document.createElement("honua-studio-canvas") as HTMLElement & {
      session?: HonuaStudioSessionAdapter;
    };
    document.body.appendChild(orphan);
    expect(resolveInjectedSession(orphan)).toBeUndefined();
    orphan.remove();
  });
});
