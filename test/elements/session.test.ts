// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { resolveInjectedAuth } from "../../src/elements/session.js";
import type { AuthSession } from "../../src/elements/types.js";

/** A minimal `AuthSession` fake, tagged with `label` (not part of the real contract) so tests can tell which one resolved. */
function fakeAuth(label: string): AuthSession & { label: string } {
  return {
    label,
    mode: "host-adapter",
    getState: () => ({ status: "fresh", accessToken: label }),
    subscribe: () => () => {},
    getAccessToken: async () => label,
    isRedirectCallback: () => false,
    handleRedirectCallback: async () => {},
    signIn: async () => {
      throw new Error("not implemented in fake");
    },
    signOut: async () => {
      throw new Error("not implemented in fake");
    },
  };
}

describe("elements/session resolveInjectedAuth", () => {
  it("prefers the element's own auth over an ancestor's", () => {
    const app = document.createElement("honua-studio-app") as HTMLElement & { auth?: AuthSession };
    app.auth = fakeAuth("app-auth");
    const child = document.createElement("honua-studio-chat") as HTMLElement & { auth?: AuthSession };
    child.auth = fakeAuth("own-auth");
    app.appendChild(child);

    expect((resolveInjectedAuth(child) as { label?: string } | undefined)?.label).toBe("own-auth");
  });

  it("falls back to the nearest honua-studio-app ancestor's auth", () => {
    const app = document.createElement("honua-studio-app") as HTMLElement & { auth?: AuthSession };
    app.auth = fakeAuth("inherited-auth");
    const wrapper = document.createElement("div");
    const child = document.createElement("honua-studio-canvas") as HTMLElement & { auth?: AuthSession };
    app.appendChild(wrapper);
    wrapper.appendChild(child);

    expect((resolveInjectedAuth(child) as { label?: string } | undefined)?.label).toBe("inherited-auth");
  });

  it("returns undefined with no own auth and no honua-studio-app ancestor", () => {
    const orphan = document.createElement("honua-studio-canvas") as HTMLElement & { auth?: AuthSession };
    document.body.appendChild(orphan);
    expect(resolveInjectedAuth(orphan)).toBeUndefined();
    orphan.remove();
  });
});
