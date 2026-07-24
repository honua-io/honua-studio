/**
 * `npm run dev` — starts the mock honua-server fixture (no network), then
 * runs `vite` with HONUA_BASE_URL pointed at it so vite.config.ts's dev
 * proxy forwards /api/* to the fixture (honua-studio#3 REQ-003).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startMockServer } from "../mock-server.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { url, close } = await startMockServer();
process.stdout.write(`[honua-studio] mock honua-server fixture listening at ${url}\n`);

const viteBin = path.join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");
const child = spawn(viteBin, [], {
  cwd: projectRoot,
  stdio: "inherit",
  env: { ...process.env, HONUA_BASE_URL: url },
});

let shuttingDown = false;
async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  await close();
  process.exit(exitCode ?? 0);
}

child.on("exit", (code) => {
  void shutdown(code ?? 0);
});
child.on("error", (error) => {
  console.error("[honua-studio] failed to start vite:", error);
  void shutdown(1);
});

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
