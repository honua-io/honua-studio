import { expect, test } from "@playwright/test";
import { evaluateRetained } from "./helpers.mjs";

test("retained evaluation survives browser GC and preserves results, errors and cleanup", async ({ page }) => {
  const operation = evaluateRetained(
    page,
    async ({ answer }) => {
      await new Promise((resolve) => {
        window.__finishRetainedEvaluation = resolve;
      });
      return { answer };
    },
    { answer: 42 },
  );
  await page.waitForFunction(() => typeof window.__finishRetainedEvaluation === "function");
  await page.requestGC();
  await page.evaluate(() => {
    window.__finishRetainedEvaluation();
    Reflect.deleteProperty(window, "__finishRetainedEvaluation");
  });
  await expect(operation).resolves.toEqual({ answer: 42 });
  await expect(
    evaluateRetained(page, async () => {
      throw new Error("retained operation rejected");
    }),
  ).rejects.toThrow("retained operation rejected");
  expect(await page.evaluate(() => Object.keys(window).filter((key) => key.startsWith("__studioOperation_")))).toEqual(
    [],
  );
});
