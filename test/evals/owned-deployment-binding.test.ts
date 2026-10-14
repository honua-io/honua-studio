import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindOwnedDeployment } from "../../scripts/lib/owned-deployment-binding.mjs";

const docker = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = Object.assign(vi.fn(), {
    [promisify.custom]: async (command: string, args: string[]) => {
      expect(command).toBe("docker");
      return { stdout: await docker(args) };
    },
  });
  return { execFile };
});
let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  docker.mockReset();
});
async function fixture(endpoint: string, hostPort: string) {
  directory = await mkdtemp(join(tmpdir(), "studio-owned-deployment-"));
  const path = join(directory, "receipt.json");
  const identity = {
    schemaVersion: "honua.owned-native-diagnostic.v1",
    endpoint,
    sourceDirty: false,
    releaseQualification: false,
    sourceSha: "a".repeat(40),
    containerId: "b".repeat(64),
    imageId: `sha256:${"c".repeat(64)}`,
    nativeBinarySha256: "d".repeat(64),
  };
  await writeFile(path, JSON.stringify(identity));
  docker.mockImplementation(async (args: string[]) => {
    if (args[0] === "inspect")
      return JSON.stringify([
        identity.containerId,
        identity.imageId,
        true,
        { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: hostPort }] },
      ]);
    if (args[0] === "image") return JSON.stringify({ "io.honua.diagnostic.source": identity.sourceSha });
    if (args[0] === "exec") return `${identity.nativeBinarySha256}  /app/Honua.Server\n`;
    throw new Error("Unexpected Docker identity command.");
  });
  return path;
}
describe("owned diagnostic deployment binding", () => {
  it.each([
    ["http://localhost", "80"],
    ["https://localhost", "443"],
    ["https://localhost:19926", "19926"],
  ])("binds the actual port for %s", async (endpoint, hostPort) => {
    const bound = await bindOwnedDeployment(await fixture(endpoint, hostPort), endpoint);
    await expect(bound.verify()).resolves.toMatchObject({ sourceSha: "a".repeat(40) });
  });
  it("rejects an HTTP port for an implicit HTTPS endpoint", async () => {
    const endpoint = "https://localhost";
    await expect(bindOwnedDeployment(await fixture(endpoint, "80"), endpoint)).rejects.toThrow("endpoint differs");
  });
  it("rejects unsupported endpoint schemes before Docker access", async () => {
    const endpoint = "ftp://localhost";
    await expect(bindOwnedDeployment(await fixture(endpoint, "21"), endpoint)).rejects.toThrow("Invalid owned");
    expect(docker).not.toHaveBeenCalled();
  });
  it("refuses a changed receipt at revalidation", async () => {
    const endpoint = "http://localhost:19926";
    const path = await fixture(endpoint, "19926");
    const bound = await bindOwnedDeployment(path, endpoint);
    await writeFile(path, "{}");
    await expect(bound.verify()).rejects.toThrow("receipt changed");
  });
});
