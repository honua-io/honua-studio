import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../docker/40-runtime-config.sh", import.meta.url));
const linuxIt = process.platform === "win32" ? it.skip : it;

describe("runtime config renderer", () => {
  linuxIt("JSON-escapes quotes and backslashes instead of interpolating syntax", async () => {
    const directory = await mkdtemp(join(tmpdir(), "honua-runtime-config-"));
    const output = join(directory, "config.json");
    try {
      execFileSync("sh", [script], {
        env: {
          ...process.env,
          HONUA_CONFIG_OUTPUT: output,
          HONUA_SERVER_BASE_URL: "https://honua.example/api",
          HONUA_OIDC_CLIENT_ID: 'studio-"quoted"-\\tenant',
          HONUA_MODEL_PROVIDER: "bedrock",
          HONUA_MODEL: 'model-"one"',
        },
      });
      expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({
        serverBaseUrl: "https://honua.example/api",
        oidc: { clientId: 'studio-"quoted"-\\tenant' },
        model: { provider: "bedrock", model: 'model-"one"' },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  linuxIt("fails closed on unsupported control characters", async () => {
    const directory = await mkdtemp(join(tmpdir(), "honua-runtime-config-"));
    try {
      expect(() =>
        execFileSync("sh", [script], {
          stdio: "pipe",
          env: { ...process.env, HONUA_CONFIG_OUTPUT: join(directory, "config.json"), HONUA_MODEL: "bad\tvalue" },
        }),
      ).toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
