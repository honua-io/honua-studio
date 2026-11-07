import { expect } from "@playwright/test";

export function liveApprovalConfiguration(environment = process.env) {
  const names = {
    consoleUrl: "HONUA_LIVE_CONSOLE_URL",
    profileId: "HONUA_LIVE_CONSOLE_PROFILE_ID",
    idpOrigin: "HONUA_LIVE_APPROVER_IDP_ORIGIN",
    username: "HONUA_LIVE_APPROVER_USERNAME",
    password: "HONUA_LIVE_APPROVER_PASSWORD",
  };
  const configuration = {};
  for (const [key, name] of Object.entries(names)) {
    if (!environment[name]) throw new Error(`${name} is required for Console publication approval.`);
    configuration[key] = environment[name];
  }
  for (const key of ["consoleUrl", "idpOrigin"]) {
    const url = new URL(configuration[key]);
    const localConsole =
      key === "consoleUrl" && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((!localConsole && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
      throw new Error(
        `${names[key]} requires HTTPS or a loopback Console URL, without credentials, query or fragment.`,
      );
    }
    if (key === "idpOrigin" && url.pathname !== "/") {
      throw new Error("HONUA_LIVE_APPROVER_IDP_ORIGIN must contain only an HTTPS origin.");
    }
  }
  return configuration;
}

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
  const signIn = new URL("auth/server/login", consoleUrl);
  signIn.searchParams.set("profileId", configuration.profileId);
  signIn.searchParams.set("returnTo", `${inbox.pathname}${inbox.search}`);
  let stage = "Console session bootstrap";
  try {
    const bootstrap = new URL("auth/login", consoleUrl);
    const version = new URL("version.json", consoleUrl);
    bootstrap.searchParams.set("returnTo", version.pathname);
    await page.goto(bootstrap.href);
    await page.waitForURL(version.href);
    stage = "sign-in redirect";
    await page.goto(signIn.href);
    await page.waitForURL((url) => url.origin === new URL(configuration.idpOrigin).origin, { timeout: 15_000 });
    stage = "identity-provider sign-in";
    await page
      .locator('input[name="username"]:visible, input[name="email"]:visible')
      .first()
      .fill(configuration.username);
    await page.locator('input[type="password"]:visible').first().fill(configuration.password);
    await page
      .getByRole("button", { name: /^(sign in|log in|continue)$/i })
      .first()
      .click();
    stage = "Console session callback";
    await page.waitForURL(inbox.href, { timeout: 60_000 });
    await expect(page.getByRole("heading", { name: "Approval inbox", exact: true })).toBeVisible();
    const panel = page.locator(".proposal-approval-panel").filter({
      has: page.getByRole("heading", { name: options.proposalId, exact: true }),
    });
    stage = "pending proposal review";
    await expect(panel).toHaveAttribute("data-proposal-id", options.proposalId);
    await expect(panel.locator("[data-proposal-status]")).toHaveAttribute("data-proposal-status", "AwaitingApproval");
    const approve = panel.locator("[data-proposal-approve]");
    await expect(approve).toBeEnabled();
    stage = "human approval";
    await approve.click();
    await expect(panel.locator("[data-proposal-status]")).toHaveAttribute(
      "data-proposal-status",
      /^(Succeeded|Failed|Rejected|Cancelled)$/,
      { timeout: 60_000 },
    );
    await expect(panel.locator("[data-proposal-status]")).toHaveAttribute("data-proposal-status", "Succeeded");
  } catch {
    // Playwright diagnostics can contain filled credentials and one-time callback codes.
    throw new Error(`Console publication approval failed during ${stage}.`);
  }
}
