import { expect, test } from "@playwright/test";
import { approveLivePublication, liveApprovalConfiguration } from "./console-publication-approval.mjs";

const credentials = {
  consoleUrl: "https://console.test/",
  profileId: "demo",
  idpOrigin: "https://identity.test",
  username: "fixture-approver",
  password: "fixture-password",
};

test("only a loopback Console may use HTTP; identity providers require HTTPS", () => {
  const environment = {
    HONUA_LIVE_CONSOLE_URL: "http://127.0.0.1:5174",
    HONUA_LIVE_CONSOLE_PROFILE_ID: "local-dev",
    HONUA_LIVE_APPROVER_IDP_ORIGIN: credentials.idpOrigin,
    HONUA_LIVE_APPROVER_USERNAME: credentials.username,
    HONUA_LIVE_APPROVER_PASSWORD: credentials.password,
  };
  expect(liveApprovalConfiguration(environment).consoleUrl).toBe("http://127.0.0.1:5174");
  expect(() => liveApprovalConfiguration({ ...environment, HONUA_LIVE_CONSOLE_URL: "http://console.test" })).toThrow();
  expect(() =>
    liveApprovalConfiguration({ ...environment, HONUA_LIVE_APPROVER_IDP_ORIGIN: "http://identity.test" }),
  ).toThrow();
});

async function installConsoleFixture(page, { status = "Succeeded", idpOrigin = credentials.idpOrigin } = {}) {
  const decisions = [];
  let consoleSessionOpened = false;
  await page.route("https://console.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/auth/login") {
      consoleSessionOpened = true;
      return route.fulfill({ status: 302, headers: { location: "https://console.test/version.json" } });
    }
    if (url.pathname === "/auth/server/login") {
      expect(consoleSessionOpened, "Console partition must exist before server sign-in").toBe(true);
      expect(url.searchParams.get("profileId")).toBe("demo");
      expect(url.searchParams.get("returnTo")).toBe("/inbox?proposalId=target-proposal");
      return route.fulfill({ status: 302, headers: { location: `${idpOrigin}/login` } });
    }
    if (url.pathname === "/approve") {
      decisions.push({ proposal: url.searchParams.get("proposal"), headers: route.request().headers() });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ status }) });
    }
    return route.fulfill({
      contentType: "text/html",
      body: `<h1>Approval inbox</h1>
        <section class="proposal-approval-panel" data-proposal-id="other-proposal"><h3>other-proposal</h3>
          <button data-proposal-approve onclick="fetch('/approve?proposal=other-proposal')">Approve &amp; submit</button>
        </section>
        <section class="proposal-approval-panel" data-proposal-id="target-proposal"><h3>target-proposal</h3>
          <span data-proposal-status="AwaitingApproval">Awaiting approval</span>
          <button data-proposal-approve onclick="approve()">Approve &amp; submit</button>
        </section>
        <script>async function approve() {
          const result = await (await fetch('/approve?proposal=target-proposal', {method: 'POST'})).json();
          document.querySelector('[data-proposal-id="target-proposal"] [data-proposal-status]')
            .setAttribute('data-proposal-status', result.status);
        }</script>`,
    });
  });
  await page.route(`${idpOrigin}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/complete") {
      expect(url.searchParams.get("username")).toBe(credentials.username);
      expect(url.searchParams.get("password")).toBe(credentials.password);
      return route.fulfill({
        status: 302,
        headers: { location: "https://console.test/inbox?proposalId=target-proposal" },
      });
    }
    return route.fulfill({
      contentType: "text/html",
      body: `<form action="/complete"><label>Username<input name="username"></label>
        <label>Password<input type="password" name="password"></label>
        <button type="submit">Sign in</button></form>`,
    });
  });
  return decisions;
}

test("Console approval signs in at the pinned IdP and clicks only the selected proposal", async ({ page }) => {
  const decisions = await installConsoleFixture(page);
  await approveLivePublication(page, { ...credentials, proposalId: "target-proposal" });
  expect(decisions).toHaveLength(1);
  expect(decisions[0].proposal).toBe("target-proposal");
  expect(decisions[0].headers.authorization).toBeUndefined();
  expect(decisions[0].headers["x-api-key"]).toBeUndefined();
});

test("Console approval cannot turn a failed proposal into success", async ({ page }) => {
  await installConsoleFixture(page, { status: "Failed" });
  await expect(approveLivePublication(page, { ...credentials, proposalId: "target-proposal" })).rejects.toThrow(
    /publication approval failed/i,
  );
});

test("Console approval never fills credentials after a redirect to a different identity origin", async ({ page }) => {
  await installConsoleFixture(page, { idpOrigin: "https://unexpected.test" });
  await expect(approveLivePublication(page, { ...credentials, proposalId: "target-proposal" })).rejects.toThrow(
    /publication approval failed/i,
  );
  await expect(page.locator('input[name="username"]')).toHaveValue("");
  await expect(page.locator('input[name="password"]')).toHaveValue("");
});

test("missing approval credentials fail before opening the Console", async ({ page }) => {
  await expect(
    approveLivePublication(page, { ...credentials, password: "", proposalId: "target-proposal" }),
  ).rejects.toThrow(/HONUA_LIVE_APPROVER_PASSWORD/);
  expect(page.url()).toBe("about:blank");
});
