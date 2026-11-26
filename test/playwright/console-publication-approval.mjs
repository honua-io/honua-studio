import { expect } from "@playwright/test";

import {
  isStaticConsole,
  liveApprovalConfiguration,
  validateApprovalUrl,
} from "../../scripts/lib/live-approval-config.mjs";
import { diagnosticRedactor, writeDiagnostic } from "../../scripts/lib/live-diagnostics.mjs";

export { liveApprovalConfiguration };

export async function approveLivePublication(page, options) {
  const configuration = liveApprovalConfiguration({
    HONUA_LIVE_CONSOLE_URL: options.consoleUrl,
    HONUA_LIVE_CONSOLE_PROFILE_ID: options.profileId,
    HONUA_LIVE_APPROVER_IDP_ORIGIN: options.idpOrigin,
    HONUA_LIVE_APPROVER_USERNAME: options.username,
    HONUA_LIVE_APPROVER_PASSWORD: options.password,
  });
  const consoleUrl = new URL(`${configuration.consoleUrl.replace(/\/$/, "")}/`);
  const inbox = new URL("inbox", consoleUrl);
  inbox.searchParams.set("proposalId", options.proposalId);
  const returnTo = `/inbox${inbox.search}`;
  const progress = { stage: "Console session bootstrap" };
  try {
    if (isStaticConsole(consoleUrl.href)) await openStaticConsoleSignIn(page, consoleUrl, returnTo, progress);
    else
      await openServerHostedSignIn(page, {
        consoleUrl,
        profileId: configuration.profileId,
        returnTo: `${inbox.pathname}${inbox.search}`,
        progress,
      });
    await page.waitForURL((url) => url.origin === new URL(configuration.idpOrigin).origin, { timeout: 15_000 });
    progress.stage = "identity-provider sign-in";
    await page
      .locator('input[name="username"]:visible, input[name="email"]:visible')
      .first()
      .fill(configuration.username);
    await page.locator('input[type="password"]:visible').first().fill(configuration.password);
    await page
      .getByRole("button", { name: /^(sign in|log in|continue)$/i })
      .first()
      .click();
    progress.stage = "Console session callback";
    await completeConsoleSignIn(page, consoleUrl, inbox);
    progress.stage = "human approval";
    await approvePublicationInInbox(page, options.proposalId);
  } catch (error) {
    await recordApprovalFailure(page, { configuration, stage: progress.stage, error });
    throw new Error(`Console publication approval failed during ${progress.stage}.`);
  }
}

/** The static bundle's callback opens the Console home with a session, not the requested page. */
async function completeConsoleSignIn(page, consoleUrl, inbox) {
  if (!isStaticConsole(consoleUrl.href)) {
    await page.waitForURL(inbox.href, { timeout: 60_000 });
    return;
  }
  await page.waitForURL((url) => url.origin === consoleUrl.origin && url.pathname.startsWith(consoleUrl.pathname), {
    timeout: 60_000,
  });
  await expect(
    page
      .getByRole("button", { name: "Sign out" })
      .or(page.getByRole("link", { name: "Open inbox" }))
      .or(page.getByRole("heading", { name: /^(Approval inbox|Approvals)$/ }))
      .first(),
  ).toBeVisible({ timeout: 30_000 });
  if (page.url() !== inbox.href) await page.goto(inbox.href);
}

/** The static bundle offers the server's identity providers on its sign-in page. */
async function openStaticConsoleSignIn(page, consoleUrl, returnTo, progress) {
  const signIn = new URL("auth/signin", consoleUrl);
  signIn.searchParams.set("returnTo", returnTo);
  await page.goto(signIn.href);
  progress.stage = "sign-in redirect";
  await page
    .getByRole("button", { name: /^Continue with / })
    .first()
    .click({ timeout: 30_000 });
}

/** The retired server-hosted Console opens its session partition before the server sign-in route. */
async function openServerHostedSignIn(page, { consoleUrl, profileId, returnTo, progress }) {
  const bootstrap = new URL("auth/login", consoleUrl);
  const version = new URL("version.json", consoleUrl);
  bootstrap.searchParams.set("returnTo", version.pathname);
  await page.goto(bootstrap.href);
  await page.waitForURL(version.href);
  progress.stage = "sign-in redirect";
  const signIn = new URL("auth/server/login", consoleUrl);
  signIn.searchParams.set("profileId", profileId);
  signIn.searchParams.set("returnTo", returnTo);
  await page.goto(signIn.href);
}

async function recordApprovalFailure(page, { configuration, stage, error }) {
  const redact = diagnosticRedactor({ extraValues: [configuration.password, configuration.username] });
  const snapshot = await page
    .locator("body")
    .ariaSnapshot()
    .catch(() => "Console page unavailable.");
  writeDiagnostic(
    ".tmp/live-diagnostics/console-approval-error-context.md",
    `Stage: ${stage}\n${error.message}\n\n${snapshot}`,
    redact,
  );
}

export async function approvePasswordPublication(page, { consoleUrl, proposalId, password }) {
  validateApprovalUrl("consoleUrl", consoleUrl);
  const base = new URL(`${consoleUrl.replace(/\/$/, "")}/`);
  await page.goto(new URL("auth/signin", base).href);
  const passwordInput = page.locator('input[type="password"]');
  await expect(passwordInput).toBeVisible();
  expect(new URL(page.url()).origin).toBe(base.origin);
  const session = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v1/admin/auth/session" && response.request().method() === "POST",
  );
  await passwordInput.fill(password);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  expect((await session).status()).toBe(204);
  const inbox = new URL("inbox", base);
  inbox.searchParams.set("proposalId", proposalId);
  await page.goto(inbox.href);
  await approvePublicationInInbox(page, proposalId);
}

async function approvePublicationInInbox(page, proposalId) {
  await expect(page.getByRole("heading", { name: /^(Approval inbox|Approvals)$/ })).toBeVisible({ timeout: 30_000 });
  const panel = page.locator(".proposal-approval-panel").filter({
    has: page.getByRole("heading", { name: proposalId, exact: true }),
  });
  await expect(panel).toHaveAttribute("data-proposal-id", proposalId);
  await expect(panel.locator("[data-proposal-status]")).toHaveAttribute("data-proposal-status", "AwaitingApproval");
  const approve = panel.locator("[data-proposal-approve]");
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(panel.locator("[data-proposal-status]")).toHaveAttribute(
    "data-proposal-status",
    /^(Succeeded|Failed|Rejected|Cancelled)$/,
    { timeout: 60_000 },
  );
  await expect(panel.locator("[data-proposal-status]")).toHaveAttribute("data-proposal-status", "Succeeded");
}
