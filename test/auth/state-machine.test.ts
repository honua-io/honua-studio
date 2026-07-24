import { describe, expect, it } from "vitest";

import { INITIAL_AUTH_STATE, reduceAuthState } from "../../src/auth/state-machine.js";
import type { AuthState } from "../../src/auth/types.js";

describe("auth state machine (fresh / refresh / rotate / expire)", () => {
  it("starts signed-out", () => {
    expect(INITIAL_AUTH_STATE).toEqual({ status: "signed-out" });
  });

  it("sign-in-started moves to signing-in", () => {
    expect(reduceAuthState(INITIAL_AUTH_STATE, { type: "sign-in-started" })).toEqual({ status: "signing-in" });
  });

  it("callback-started moves to authenticating", () => {
    const state = reduceAuthState({ status: "signing-in" }, { type: "callback-started" });
    expect(state).toEqual({ status: "authenticating" });
  });

  it("credential-issued lands on fresh with the token and expiry", () => {
    const state = reduceAuthState(
      { status: "authenticating" },
      { type: "credential-issued", accessToken: "access-1", expiresAt: 1000 },
    );
    expect(state).toEqual({ status: "fresh", accessToken: "access-1", expiresAt: 1000 });
  });

  it("refresh-started moves fresh -> refreshing without losing the current token", () => {
    const fresh: AuthState = { status: "fresh", accessToken: "access-1", expiresAt: 1000 };
    const state = reduceAuthState(fresh, { type: "refresh-started" });
    expect(state).toEqual({ status: "refreshing", accessToken: "access-1", expiresAt: 1000 });
  });

  it("token-rotated moves refreshing -> fresh with the rotated token", () => {
    const refreshing: AuthState = { status: "refreshing", accessToken: "access-1", expiresAt: 1000 };
    const state = reduceAuthState(refreshing, {
      type: "token-rotated",
      accessToken: "access-2",
      expiresAt: 2000,
    });
    expect(state).toEqual({ status: "fresh", accessToken: "access-2", expiresAt: 2000 });
  });

  it("refresh-failed moves refreshing -> expired with the failure reason", () => {
    const refreshing: AuthState = { status: "refreshing", accessToken: "access-1", expiresAt: 1000 };
    const state = reduceAuthState(refreshing, { type: "refresh-failed", error: "invalid_grant" });
    expect(state).toEqual({ status: "expired", error: "invalid_grant" });
  });

  it("signed-out always resets to the initial state, even mid-refresh", () => {
    const refreshing: AuthState = { status: "refreshing", accessToken: "access-1", expiresAt: 1000 };
    expect(reduceAuthState(refreshing, { type: "signed-out" })).toEqual({ status: "signed-out" });
  });

  it("a full fresh -> refresh -> rotate -> fresh cycle never drops the session", () => {
    let state = INITIAL_AUTH_STATE;
    state = reduceAuthState(state, { type: "sign-in-started" });
    state = reduceAuthState(state, { type: "callback-started" });
    state = reduceAuthState(state, { type: "credential-issued", accessToken: "access-1", expiresAt: 1000 });
    expect(state.status).toBe("fresh");

    state = reduceAuthState(state, { type: "refresh-started" });
    expect(state.status).toBe("refreshing");
    expect(state.accessToken).toBe("access-1"); // still usable while the refresh is in flight

    state = reduceAuthState(state, { type: "token-rotated", accessToken: "access-2", expiresAt: 2000 });
    expect(state).toEqual({ status: "fresh", accessToken: "access-2", expiresAt: 2000 });
  });

  it("a refresh that ultimately fails ends in expired, not a silent fresh", () => {
    let state = reduceAuthState(INITIAL_AUTH_STATE, {
      type: "credential-issued",
      accessToken: "access-1",
      expiresAt: 1000,
    });
    state = reduceAuthState(state, { type: "refresh-started" });
    state = reduceAuthState(state, { type: "refresh-failed", error: "unknown or already-rotated refresh token" });
    expect(state).toEqual({ status: "expired", error: "unknown or already-rotated refresh token" });
  });
});
