import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { serverOrigin } from "./lib/live-compose.mjs";
import { approvalObserverPort, collectPlaywrightContexts } from "./lib/live-diagnostics.mjs";
import { startLiveModelGuard } from "./lib/live-model-guard.mjs";

const guard = await startLiveModelGuard(serverOrigin, { host: "0.0.0.0", port: approvalObserverPort });
let child;
let interrupt;
const interrupted = new Promise((resolve) => {
  interrupt = resolve;
});
const cancel = (signal) => interrupt(signal === "SIGINT" ? 130 : 143);
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);

function persistEvidence() {
  const evidence = guard.evidence();
  mkdirSync(".tmp", { recursive: true });
  writeFileSync(".tmp/live-model-usage.json", JSON.stringify(evidence, null, 2));
  console.log(`Live model usage: ${JSON.stringify(evidence)}`);
}

function stopBrowser(signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

try {
  child = spawn("npm", ["run", "test:browser:live", "--", "--reporter=list,json", "--retries=0"], {
    detached: true,
    stdio: "inherit",
    env: { ...process.env, HONUA_LIVE_BASE_URL: `${guard.origin}/api` },
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  const exitCode = await Promise.race([exited, interrupted]);
  process.exitCode = exitCode;
  if (exitCode === 0) guard.assertQualified();
} catch (error) {
  process.exitCode ||= 1;
  console.error(error.message);
} finally {
  persistEvidence();
  stopBrowser("SIGTERM");
  setTimeout(() => stopBrowser("SIGKILL"), 1000);
  try {
    await guard.close();
  } catch (error) {
    process.exitCode ||= 1;
    console.error(error.message);
  } finally {
    persistEvidence();
    collectPlaywrightContexts();
  }
}
