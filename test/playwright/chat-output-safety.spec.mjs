/** Source-regression coverage for literal, non-executable chat output; no model or installed qualification. */
import { expect, test } from "@playwright/test";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { startPreviewServer } from "./helpers.mjs";

const CANARY_ORIGIN = "https://studio-output-canary.invalid";
const PAYLOAD = `literal ' " & </p></pre></li></ul><img src="${CANARY_ORIGIN}/image" onerror="window.__studioOutputCanaryExecutions++"><svg onload="window.__studioOutputCanaryExecutions++"></svg><script>window.__studioOutputCanaryExecutions++</script><style>@import url('${CANARY_ORIGIN}/style');</style><a href="javascript:window.__studioOutputCanaryExecutions++">link</a>[markdown](javascript:window.__studioOutputCanaryExecutions++)`;

async function withChat(page, run) {
  const attemptedCanaryRequests = [];
  // Record before aborting: blocked traffic is still a failure, not evidence of safe rendering.
  await page.route(`${CANARY_ORIGIN}/**`, async (route) => {
    attemptedCanaryRequests.push(route.request().url());
    await route.abort();
  });
  const mock = await startMockServer();
  const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
  try {
    await page.addInitScript((token) => {
      window.__honuaStudioFixtureToken = token;
      window.__studioOutputCanaryExecutions = 0;
    }, mintFixtureAccessToken());
    await page.goto(`${preview.url}/harness/bare/index.html`);
    await page.evaluate(async () => {
      await customElements.whenDefined("honua-studio-chat");
      // Public registry/element contract, independent of shell orchestration and real tools.
      const chat = document.createElement("honua-studio-chat");
      chat.id = "output-safety-chat";
      document.body.append(chat);
      window.__outputSafetyBaselineStyles = chat.shadowRoot.querySelectorAll("style").length;
    });
    await run(page.locator("#output-safety-chat"), attemptedCanaryRequests);
  } finally {
    await page.close();
    await preview.close();
    await mock.close();
  }
}

async function expectLiteral(locator, text) {
  await expect(locator).toHaveText(text);
  // Playwright normalizes whitespace in toHaveText; retain a byte-exact DOM text assertion too.
  expect(await locator.textContent()).toBe(text);
}

async function assertInert(page, attemptedCanaryRequests) {
  // Give browser event handlers/resource requests a rendering opportunity, including during streaming.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const observed = await page.evaluate(() => {
    const root = document.querySelector("#output-safety-chat").shadowRoot;
    return {
      executableOrLinkNodes: root.querySelectorAll(
        "script,img,svg,iframe,object,embed,a,link,base,meta,[srcdoc],[href]",
      ).length,
      inlineHandlers: [...root.querySelectorAll("*")]
        .flatMap((node) => [...node.attributes])
        .filter((attribute) => attribute.name.toLowerCase().startsWith("on")).length,
      styles: root.querySelectorAll("style").length,
      baselineStyles: window.__outputSafetyBaselineStyles,
      executions: window.__studioOutputCanaryExecutions,
    };
  });
  expect(observed.executableOrLinkNodes).toBe(0);
  expect(observed.inlineHandlers).toBe(0);
  expect(observed.styles).toBe(observed.baselineStyles);
  expect(observed.executions).toBe(0);
  expect(attemptedCanaryRequests).toEqual([]);
}

test("streamed narrative and pending/completed tool fields remain exact literal text", async ({ page }) => {
  await withChat(page, async (chat, attempted) => {
    await page.evaluate((payload) => {
      const element = document.querySelector("#output-safety-chat");
      element.transport = {
        async *streamChat() {
          yield { type: "messageStart", model: "fixture" };
          yield { type: "textDelta", text: payload };
          yield { type: "toolCallStart", toolCallId: payload, toolName: payload };
          yield { type: "toolCallDelta", toolCallId: payload, toolArgumentsDelta: JSON.stringify({ note: payload }) };
          await new Promise((resolve) => {
            window.__continueOutputSafety = resolve;
          });
          yield { type: "toolCallStop", toolCallId: payload, toolArguments: { note: payload } };
          yield { type: "messageStop", stopReason: "endTurn" };
        },
      };
      window.__outputSafetyTurn = element.sendMessage(payload);
    }, PAYLOAD);
    const text = chat.getByTestId("studio-chat-message-text");
    await expect(text).toHaveCount(2);
    await expectLiteral(text.nth(0), PAYLOAD);
    await expectLiteral(text.nth(1), PAYLOAD);
    await expectLiteral(chat.locator(".chat-tool-call-name"), PAYLOAD);
    await expect(chat.getByTestId("studio-chat-tool-call")).toHaveAttribute("data-tool-call-id", PAYLOAD);
    await expectLiteral(chat.getByTestId("studio-chat-tool-call-args"), JSON.stringify({ note: PAYLOAD }));
    await assertInert(page, attempted);
    await page.evaluate(async () => {
      window.__continueOutputSafety();
      await window.__outputSafetyTurn;
    });
    await expect(chat.getByTestId("studio-chat-tool-call")).toHaveAttribute("data-status", "complete");
    expect(await chat.getByTestId("studio-chat-tool-call-args").textContent()).toBe(
      JSON.stringify({ note: PAYLOAD }, null, 2),
    );
    await assertInert(page, attempted);
  });
});

test("host-delivered failed tool and turn errors stay literal and inert", async ({ page }) => {
  await withChat(page, async (chat, attempted) => {
    await page.evaluate(async (payload) => {
      const element = document.querySelector("#output-safety-chat");
      element.agentSessionAdapter = {
        async submitTurn(_prompt, { onEvent }) {
          onEvent({ type: "chat", event: { type: "textDelta", text: payload } });
          onEvent({ type: "chat", event: { type: "toolCallStart", toolCallId: payload, toolName: payload } });
          onEvent({ type: "chat", event: { type: "toolCallDelta", toolCallId: payload, toolArgumentsDelta: payload } });
          onEvent({
            type: "toolResult",
            result: {
              toolCallId: payload,
              toolName: payload,
              plane: "composition",
              ok: false,
              errorMessage: payload,
              content: "",
            },
          });
          return { status: "error", text: payload, errorMessage: payload, rounds: 1, toolCalls: [] };
        },
      };
      await element.sendMessage("Fail the synthetic tool");
    }, PAYLOAD);
    await expectLiteral(chat.locator(".chat-tool-call-name"), PAYLOAD);
    await expectLiteral(chat.getByTestId("studio-chat-tool-call-args"), PAYLOAD);
    await expectLiteral(chat.locator(".chat-tool-call .hn-error"), PAYLOAD);
    await expectLiteral(chat.getByTestId("studio-chat-message-error"), PAYLOAD);
    await expect(chat.getByTestId("studio-chat-tool-call")).toHaveAttribute("data-status", "error");
    await assertInert(page, attempted);
  });
});

test("host conversation replay and share notes never turn HTML or Markdown URLs into nodes", async ({ page }) => {
  await withChat(page, async (chat, attempted) => {
    const accepted = await page.evaluate((payload) => {
      const element = document.querySelector("#output-safety-chat");
      element.shareNote = payload;
      return element.setWorkspaceConversation([
        { id: payload, role: "assistant", content: payload },
        { id: "replayed-user", role: "user", content: payload },
      ]);
    }, PAYLOAD);
    expect(accepted).toBe(true);
    const text = chat.getByTestId("studio-chat-message-text");
    await expect(text).toHaveCount(2);
    await expectLiteral(text.nth(0), PAYLOAD);
    await expectLiteral(text.nth(1), PAYLOAD);
    await expect(chat.getByTestId("studio-chat-message").first()).toHaveAttribute("data-message-id", PAYLOAD);
    await expectLiteral(chat.getByTestId("studio-chat-share-status"), PAYLOAD);
    await assertInert(page, attempted);
  });
});
