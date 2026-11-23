import { readFileSync, rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  approveLivePublication,
  approvePasswordPublication,
  liveApprovalConfiguration,
} from "./console-publication-approval.mjs";

const credentials = {
  consoleUrl: "https://console.test/",
  profileId: "demo",
  idpOrigin: "https://identity.test",
  username: "fixture-approver",
  password: "fixture-password",
};

function navigateSyntheticOrigin(route, destination) {
  return route.fulfill({
    contentType: "text/html",
    body: `<script>location.replace(${JSON.stringify(destination)})</script>`,
  });
}

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
      return navigateSyntheticOrigin(route, "https://console.test/version.json");
    }
    if (url.pathname === "/auth/server/login") {
      expect(consoleSessionOpened, "Console partition must exist before server sign-in").toBe(true);
      expect(url.searchParams.get("profileId")).toBe("demo");
      expect(url.searchParams.get("returnTo")).toBe("/inbox?proposalId=target-proposal");
      return navigateSyntheticOrigin(route, `${idpOrigin}/login`);
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
      return navigateSyntheticOrigin(route, "https://console.test/inbox?proposalId=target-proposal");
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
  rmSync(".tmp/live-diagnostics/console-approval-error-context.md", { force: true });
  await installConsoleFixture(page, { status: "Failed" });
  await expect(approveLivePublication(page, { ...credentials, proposalId: "target-proposal" })).rejects.toThrow(
    "Console publication approval failed during human approval.",
  );
  const snapshot = readFileSync(".tmp/live-diagnostics/console-approval-error-context.md", "utf8");
  expect(snapshot).toContain("Stage: human approval");
  expect(snapshot).toContain("Failed");
  expect(snapshot).not.toContain(credentials.password);
  expect(snapshot).not.toContain(credentials.username);
});

test("Console approval never fills credentials after a redirect to a different identity origin", async ({ page }) => {
  await installConsoleFixture(page, { idpOrigin: "https://unexpected.test" });
  await expect(approveLivePublication(page, { ...credentials, proposalId: "target-proposal" })).rejects.toThrow(
    "Console publication approval failed during sign-in redirect.",
  );
  await expect(page.locator('input[name="username"]')).toHaveValue("");
  await expect(page.locator('input[name="password"]')).toHaveValue("");
});

const staticCredentials = { ...credentials, consoleUrl: "https://console.test/console", profileId: undefined };

/** The static bundle at /console/: its sign-in page offers the server's identity providers. */
async function installStaticConsoleFixture(page, { idpOrigin = credentials.idpOrigin } = {}) {
  const decisions = [];
  const inbox = "https://console.test/console/inbox?proposalId=target-proposal";
  await page.route("https://console.test/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/console/auth/signin") {
      expect(url.searchParams.get("returnTo")).toBe("/inbox?proposalId=target-proposal");
      return route.fulfill({
        contentType: "text/html",
        body: `<h1>Sign in</h1><button type="button" onclick="location.assign('${idpOrigin}/login')">Continue with Studio realm</button>`,
      });
    }
    if (url.pathname === "/approve") {
      decisions.push({ proposal: url.searchParams.get("proposal"), headers: route.request().headers() });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "Succeeded" }) });
    }
    if (url.href === "https://console.test/console/")
      return route.fulfill({
        contentType: "text/html",
        body: '<h1>Welcome</h1><button type="button">Sign out</button>',
      });
    if (url.href !== inbox) return route.fulfill({ status: 404, body: "unexpected Console route" });
    return route.fulfill({
      contentType: "text/html",
      body: `<h1>Approvals</h1>
        <section class="proposal-approval-panel" data-proposal-id="target-proposal"><h3>target-proposal</h3>
          <span data-proposal-status="AwaitingApproval">Awaiting approval</span>
          <button data-proposal-approve onclick="approve()">Approve &amp; submit</button>
        </section>
        <script>async function approve() {
          const result = await (await fetch('/approve?proposal=target-proposal', {method: 'POST'})).json();
          document.querySelector('[data-proposal-status]').setAttribute('data-proposal-status', result.status);
        }</script>`,
    });
  });
  await page.route(`${idpOrigin}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/complete") {
      expect(url.searchParams.get("username")).toBe(credentials.username);
      expect(url.searchParams.get("password")).toBe(credentials.password);
      return navigateSyntheticOrigin(route, "https://console.test/console/");
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

test("static Console approval continues with the server identity provider and approves only the selected proposal", async ({
  page,
}) => {
  const decisions = await installStaticConsoleFixture(page);
  await approveLivePublication(page, { ...staticCredentials, proposalId: "target-proposal" });
  expect(decisions).toHaveLength(1);
  expect(decisions[0].proposal).toBe("target-proposal");
  expect(decisions[0].headers.authorization).toBeUndefined();
  expect(decisions[0].headers["x-api-key"]).toBeUndefined();
});

test("static Console approval never fills credentials at an unexpected identity origin", async ({ page }) => {
  await installStaticConsoleFixture(page, { idpOrigin: "https://unexpected.test" });
  await expect(approveLivePublication(page, { ...staticCredentials, proposalId: "target-proposal" })).rejects.toThrow(
    "Console publication approval failed during sign-in redirect.",
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

async function installPasswordFixture(page, status) {
  const decisions = await installConsoleFixture(page, { status });
  await page.route("https://console.test/auth/signin", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<form onsubmit="event.preventDefault(); fetch('/api/v1/admin/auth/session', {
      method: 'POST', body: document.querySelector('input').value
    })"><input type="password"><button>Continue</button></form>`,
    }),
  );
  await page.route("https://console.test/api/v1/admin/auth/session", (route) => {
    expect(route.request().postData()).toBe(credentials.password);
    return route.fulfill({ status: 204 });
  });
  return decisions;
}

test("password approval opens a browser session and approves only the selected proposal", async ({ page }) => {
  const decisions = await installPasswordFixture(page, "Succeeded");
  await approvePasswordPublication(page, { ...credentials, proposalId: "target-proposal" });
  expect(decisions).toHaveLength(1);
  expect(decisions[0].proposal).toBe("target-proposal");
  expect(decisions[0].headers.authorization).toBeUndefined();
  expect(decisions[0].headers["x-api-key"]).toBeUndefined();
});

test("password approval refuses a failed proposal", async ({ page }) => {
  await installPasswordFixture(page, "Failed");
  await expect(approvePasswordPublication(page, { ...credentials, proposalId: "target-proposal" })).rejects.toThrow();
});

test("password approval never fills credentials after an off-origin redirect", async ({ page }) => {
  await page.route("https://console.test/auth/signin", (route) =>
    navigateSyntheticOrigin(route, "https://unexpected.test/signin"),
  );
  await page.route("https://unexpected.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: '<input type="password">' }),
  );
  await expect(approvePasswordPublication(page, { ...credentials, proposalId: "target-proposal" })).rejects.toThrow();
  await expect(page.locator('input[type="password"]')).toHaveValue("");
});

for (const suffix of ["?tenant=a", "#approval"]) {
  test(`password approval rejects a Console URL with ${suffix}`, async ({ page }) => {
    await expect(
      approvePasswordPublication(page, {
        ...credentials,
        consoleUrl: `https://console.test/console${suffix}`,
        proposalId: "target-proposal",
      }),
    ).rejects.toThrow(/without credentials, query or fragment/);
    expect(page.url()).toBe("about:blank");
  });
}
