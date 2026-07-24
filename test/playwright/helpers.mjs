/** Shared Playwright boot-smoke helpers: spawns `vite preview` and waits for it to report ready. */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const START_TIMEOUT_MS = 20_000;

/**
 * @param {Record<string,string>} extraEnv
 * @param {string[]} extraArgs
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function startPreviewServer(extraEnv = {}, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const viteBin = path.join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");
    const child = spawn(viteBin, ["preview", "--host", "127.0.0.1", ...extraArgs], {
      cwd: projectRoot,
      // NO_COLOR keeps vite's stdout free of ANSI escapes so the "Local:"
      // line parses reliably regardless of how the parent's stdout is
      // piped (Playwright's test runner reports a color-capable TTY even
      // though this process only pipes the output, unlike a plain `node`
      // invocation).
      env: { ...process.env, ...extraEnv, NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let output = "";

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Timed out waiting for vite preview to start. Output so far:\n${output}`));
    }, START_TIMEOUT_MS);

    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/Local:\s+(http:\/\/[^\s/]+)\/?/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          url: match[1],
          async close() {
            child.kill("SIGTERM");
            await new Promise((resolveClose) => child.once("exit", resolveClose));
          },
        });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`vite preview exited early with code ${code}. Output:\n${output}`));
    });
  });
}
