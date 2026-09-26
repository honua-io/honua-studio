/**
 * Browser journey against the versioned self-hosted Studio image.
 *
 * Builds nothing. Point `--image` at an image already built from this
 * checkout's Dockerfile (CI uses `honua-studio:ci`). Injected `/config.json`
 * selects the local BYOM preview model. No demo credential and no GHCR digest
 * is required or invented. Studio stays Preview.
 *
 *   node scripts/self-hosted-preview-receipt.mjs --image honua-studio:ci
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

import { OIDC_CLIENT_ID, mintFixtureAccessToken, startMockServer } from "../mock-server.mjs";
import { buildSelfHostedPreviewReceipt } from "./lib/self-hosted-preview-receipt.mjs";

const IMAGE_REPOSITORY = "ghcr.io/honua-io/honua-studio";
const PROMPT = "Add the Hawaii parcels layer, zoom the map, save a version, reopen it, and propose sharing it.";

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr || stdout}`));
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function jsonField(text, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(text);
  return match?.[1];
}

async function main() {
  const image = argValue("--image") ?? "honua-studio:ci";
  const mock = await startMockServer({ model: "byom-preview" });
  const directory = await mkdtemp(join(tmpdir(), "honua-studio-preview-"));
  const configPath = join(directory, "config.json");
  const config = {
    schemaVersion: "honua.studio.runtime-config.v1",
    serverBaseUrl: mock.url,
    mcpBaseUrl: mock.url,
    oidc: {
      issuer: `${mock.url}/oidc`,
      clientId: OIDC_CLIENT_ID,
      scopes: ["openid", "profile", "honua.read", "honua.write"],
    },
    model: { mode: "server-proxy", provider: "byom-preview" },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });

  const port = await freePort();
  const container = `honua-studio-preview-${process.pid}`;
  let browser;
  try {
    await run("docker", [
      "run",
      "--rm",
      "-d",
      "--name",
      container,
      "--read-only",
      "--tmpfs",
      "/var/cache/nginx:uid=101,gid=101",
      "--tmpfs",
      "/var/run:uid=101,gid=101",
      "-p",
      `127.0.0.1:${port}:8080`,
      "--mount",
      `type=bind,src=${configPath},dst=/usr/share/nginx/html/config.json,readonly`,
      image,
    ]);
    const origin = `http://127.0.0.1:${port}`;
    let served;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const response = await fetch(`${origin}/config.json`, { cache: "no-store" });
        if (response.ok) {
          served = await response.json();
          break;
        }
      } catch {
        // nginx is still starting
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (served?.schemaVersion !== "honua.studio.runtime-config.v1" || served.serverBaseUrl !== mock.url) {
      throw new Error("The container did not serve the injected runtime config.");
    }

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.getByTestId("auth-signin").click();
    await page.getByTestId("auth-status").filter({ hasText: "Signed in" }).waitFor({ timeout: 20_000 });
    const packageKey = `self-hosted-preview-${Date.now()}`;
    await page.evaluate((key) => {
      window.__honuaStudioApp.enableLiveComposition({
        baseUrl: window.__honuaStudioRuntimeConfig.mcpBaseUrl,
        packageKey: key,
        family: "map",
        schemaVersion: "1.0",
      });
    }, packageKey);
    await page.waitForFunction(() => Boolean(window.__honuaStudioChat.agentSession), null, { timeout: 20_000 });
    await page.evaluate((text) => window.__honuaStudioChat.sendMessage(text), PROMPT);
    await page.waitForFunction(
      () => {
        const messages = window.__honuaStudioChat.agentSession?.messages ?? [];
        return messages.some((message) => message.role === "tool" && String(message.content).includes("proposalId"));
      },
      null,
      { timeout: 45_000 },
    );
    const observed = await page.evaluate(() => {
      const messages = window.__honuaStudioChat.agentSession.messages;
      const assistant = [...messages].reverse().find((message) => message.role === "assistant");
      return {
        draftId: window.__honuaStudioApp.toolCallOrchestrator.draftId,
        messages: messages.map((message) => ({
          role: message.role,
          toolName: message.toolName,
          content: message.content,
        })),
        assistantText: assistant?.content ?? "",
      };
    });
    const toolText = observed.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.content)
      .join("\n");
    const toolNames = observed.messages.filter((message) => message.role === "tool").map((message) => message.toolName);
    const proposalId = jsonField(toolText, "proposalId");
    if (!proposalId) throw new Error(`The browser session did not record a proposal. ${observed.assistantText}`);

    const proposer = await page.evaluate(
      async ({ baseUrl, id }) => {
        const token = await window.__honuaStudioApp.auth.getAccessToken();
        const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
        const pending = await fetch(`${baseUrl}/v1/studio/publication-proposals/${id}`, { headers });
        const pendingBody = await pending.json();
        const denied = await fetch(`${baseUrl}/v1/studio/publication-proposals/${id}/decision`, {
          method: "POST",
          headers,
          body: JSON.stringify({ decision: "approve" }),
        });
        return { status: pending.status, pending: pendingBody, denied: denied.status, token };
      },
      { baseUrl: mock.url, id: proposalId },
    );
    if (proposer.denied !== 403) {
      throw new Error(`The proposing browser session was able to approve (HTTP ${proposer.denied}).`);
    }
    if (proposer.pending?.data?.approvedUrl) {
      throw new Error("The proposal exposed an approved URL before a separate principal approved it.");
    }

    const approverToken = mintFixtureAccessToken({
      sub: "studio-approver",
      name: "Preview Approver",
      email: "approver@honua.io",
      roles: ["approver"],
    });
    const decision = await fetch(`${mock.url}/v1/studio/publication-proposals/${proposalId}/decision`, {
      method: "POST",
      headers: { authorization: `Bearer ${approverToken}`, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    if (!decision.ok) throw new Error(`Approver decision failed (HTTP ${decision.status}).`);
    const approved = await page.evaluate(
      async ({ baseUrl, id }) => {
        const token = await window.__honuaStudioApp.auth.getAccessToken();
        const response = await fetch(`${baseUrl}/v1/studio/publication-proposals/${id}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const body = await response.json();
        const url = body?.data?.approvedUrl;
        if (!url) return { status: response.status, body };
        const published = await fetch(url);
        return {
          status: response.status,
          approvedUrl: url,
          publishedStatus: published.status,
          published: await published.json(),
        };
      },
      { baseUrl: mock.url, id: proposalId },
    );
    if (approved.publishedStatus !== 200 || approved.published?.versionId !== jsonField(toolText, "savedVersionId")) {
      throw new Error("The browser could not read a working approved URL for the saved version.");
    }

    const [sourceSha, localImageId] = await Promise.all([
      run("git", ["rev-parse", "HEAD"]),
      run("docker", ["inspect", "--format", "{{.Id}}", image]),
    ]);
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const reopenedDraftId = observed.draftId;
    const receipt = buildSelfHostedPreviewReceipt({
      posture: "preview",
      ga: false,
      sourceSha,
      sdk: { name: "@honua/sdk-js", version: packageJson.dependencies["@honua/sdk-js"] },
      image: { repository: IMAGE_REPOSITORY, published: false, localImageId },
      runtimeConfig: { schemaVersion: served.schemaVersion, modelMode: served.model.mode },
      model: { provider: "byom-preview", hosted: false, credentialRequired: false },
      journey: {
        draftId: jsonField(toolText, "draftId"),
        savedVersionId: jsonField(toolText, "savedVersionId"),
        contentHash: jsonField(toolText, "savedContentHash"),
        reopenedDraftId,
        proposalId,
        approvedUrl: approved.approvedUrl,
        proposerSubject: "studio-dev-user",
        approverSubject: "studio-approver",
        toolNames,
      },
    });
    if (receipt.journey.draftId === receipt.journey.reopenedDraftId) {
      throw new Error("Reopen did not bind the browser to a new draft.");
    }
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } finally {
    await browser?.close();
    await run("docker", ["rm", "-f", container]).catch(() => undefined);
    await mock.close();
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
