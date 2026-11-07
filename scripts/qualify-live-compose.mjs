import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { serverOrigin } from "./lib/live-compose.mjs";
import { startLiveModelGuard } from "./lib/live-model-guard.mjs";

const guard = await startLiveModelGuard(serverOrigin);
try {
  const child = spawn("npm", ["run", "test:browser:live", "--", "--reporter=list,json", "--retries=0"], {
    stdio: "inherit",
    env: { ...process.env, HONUA_LIVE_BASE_URL: `${guard.origin}/api` },
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  guard.assertQualified();
  process.exitCode = exitCode;
} finally {
  await guard.close();
  const evidence = guard.evidence();
  mkdirSync(".tmp", { recursive: true });
  writeFileSync(".tmp/live-model-usage.json", JSON.stringify(evidence, null, 2));
  console.log(`Live model usage: ${JSON.stringify(evidence)}`);
}
