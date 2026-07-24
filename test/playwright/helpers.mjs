/** Shared Playwright boot-smoke helpers: spawns `vite preview` (or, for the Blazor host spec, `dotnet run`) and waits for it to report ready. */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const START_TIMEOUT_MS = 20_000;
const BLAZOR_START_TIMEOUT_MS = 30_000;

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

/**
 * Starts the Blazor Web App test host (harness/blazor-host/StudioHost) via
 * `dotnet run` and resolves once Kestrel reports its listening URL.
 * `--no-launch-profile` + `ASPNETCORE_URLS=http://127.0.0.1:0` together get
 * Kestrel to bind an OS-assigned free port (mirrors `vite preview`'s own
 * port-0 behavior above) instead of the fixed port in launchSettings.json,
 * so this spec can run alongside every other Playwright spec's own server
 * without a port clash. Caller is responsible for building the project
 * first (`dotnet build harness/blazor-host/StudioHost/StudioHost.csproj`,
 * scoped — see harness/blazor-host/README.md) — this only runs it.
 */
export function startBlazorHost() {
  return new Promise((resolve, reject) => {
    const projectPath = path.join(projectRoot, "harness/blazor-host/StudioHost");
    const child = spawn("dotnet", ["run", "--no-build", "--no-launch-profile", "--project", projectPath], {
      cwd: projectPath,
      env: {
        ...process.env,
        ASPNETCORE_URLS: "http://127.0.0.1:0",
        // --no-launch-profile (needed for the dynamic free port above) also
        // skips launchSettings.json's ASPNETCORE_ENVIRONMENT=Development —
        // without it the host falls back to Production, where
        // MapStaticAssets()'s precompressed-asset negotiation 500s on this
        // machine's Kestrel/SDK combination. Development is also just the
        // correct environment for a test harness.
        ASPNETCORE_ENVIRONMENT: "Development",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let output = "";

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Timed out waiting for the Blazor host to start. Output so far:\n${output}`));
    }, BLAZOR_START_TIMEOUT_MS);

    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/Now listening on:\s+(http:\/\/\S+)/);
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
      reject(new Error(`dotnet run exited early with code ${code}. Output:\n${output}`));
    });
  });
}
