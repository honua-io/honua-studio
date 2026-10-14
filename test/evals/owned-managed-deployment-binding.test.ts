import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindOwnedDeployment } from "../../scripts/lib/owned-deployment-binding.mjs";

const docker = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return {
    execFile: Object.assign(vi.fn(), {
      [promisify.custom]: async (command: string, args: string[]) => {
        expect(command).toBe("docker");
        return { stdout: await docker(args) };
      },
    }),
  };
});
let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  docker.mockReset();
});
const endpoint = "http://localhost:19927";
const assembly = "/managed/Honua.Server.dll";
const runtimeConfig = "/managed/Honua.Server.runtimeconfig.json";
const executable = "/diagnostic-dotnet/dotnet";
const manifestPath = "/diagnostic/managed-closure.sha256";
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
async function fixture() {
  directory = await mkdtemp(join(tmpdir(), "studio-managed-deployment-"));
  const path = join(directory, "receipt.json");
  const files: Record<string, string> = Object.fromEntries(
    [
      assembly,
      runtimeConfig,
      executable,
      "/diagnostic-dotnet/host/fxr/10.0.11/libhostfxr.so",
      "/managed/libcoreclr.so",
      "/managed/libhostpolicy.so",
    ].map((name) => [name, hash(name)]),
  );
  const names = Object.keys(files).sort();
  const manifestBody = `${names.map((name) => `${files[name]}  ${name}`).join("\n")}\n`;
  const identity = {
    schemaVersion: "honua.owned-managed-diagnostic.v1",
    endpoint,
    sourceDirty: false,
    releaseQualification: false,
    securityQualification: false,
    syntheticData: true,
    runtimeKind: "managed-jit",
    sourceSha: "a".repeat(40),
    containerId: "b".repeat(64),
    imageId: `sha256:${"c".repeat(64)}`,
    managedAssemblyPath: assembly,
    managedAssemblySha256: files[assembly],
    runtimeConfigPath: runtimeConfig,
    runtimeConfigSha256: files[runtimeConfig],
    runtimeExecutable: executable,
    entrypoint: [executable, "exec", assembly],
    cmd: [],
    closureManifestPath: manifestPath,
    closureManifestSha256: hash(manifestBody),
    closureFiles: files,
  };
  const actual = {
    containerId: identity.containerId,
    imageId: identity.imageId,
    running: true,
    port: "19927",
    sourceSha: identity.sourceSha,
    path: executable,
    args: ["exec", assembly],
    entrypoint: identity.entrypoint,
    cmd: [] as string[] | null,
    manifestBody,
    inventory: `${names.join("\n")}\n`,
    links: "",
    hashes: manifestBody,
  };
  await writeFile(path, JSON.stringify(identity));
  docker.mockImplementation(async (args: string[]) => {
    if (args[0] === "inspect")
      return JSON.stringify([
        actual.containerId,
        actual.imageId,
        actual.running,
        { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: actual.port }] },
        actual.path,
        actual.args,
        actual.entrypoint,
        actual.cmd,
      ]);
    if (args[0] === "image") return JSON.stringify({ "io.honua.diagnostic.source": actual.sourceSha });
    if (args[2] === "cat") {
      expect(args[3]).toBe(manifestPath);
      return actual.manifestBody;
    }
    if (args[2] === "find") return args.at(-1) === "l" ? actual.links : actual.inventory;
    if (args[2] === "sha256sum") {
      expect(args.slice(3)).toEqual(["--", ...names]);
      return actual.hashes;
    }
    throw new Error(`Unexpected identity command: ${args.join(" ")}`);
  });
  return { path, identity, actual };
}

describe("owned managed functional deployment binding", () => {
  it("revalidates the actual command and every managed/runtime file without native qualification", async () => {
    const { path, actual } = await fixture();
    actual.cmd = null;
    const bound = await bindOwnedDeployment(path, endpoint);
    await expect(bound.verify()).resolves.toMatchObject({
      runtimeKind: "managed-jit",
      verifiedFileCount: 6,
      managedAssemblySha256: hash(assembly),
      releaseQualification: false,
      securityQualification: false,
    });
    expect(JSON.stringify(bound.identity)).not.toContain("nativeBinarySha256");
    expect(docker.mock.calls.every(([args]) => !args.join(" ").includes(".Config.Env"))).toBe(true);
  });
  it.each(["containerId", "imageId", "port", "sourceSha", "path"] as const)(
    "refuses changed actual %s",
    async (field) => {
      const { path, actual } = await fixture();
      actual[field] = "changed";
      await expect(bindOwnedDeployment(path, endpoint)).rejects.toThrow(/differs/);
    },
  );
  it.each(["args", "entrypoint", "cmd"] as const)("rejects an altered actual %s", async (field) => {
    const { path, actual } = await fixture();
    actual[field] = ["unreviewed.dll"];
    await expect(bindOwnedDeployment(path, endpoint)).rejects.toThrow("entrypoint differs");
  });
  it("rejects a stopped container", async () => {
    const { path, actual } = await fixture();
    actual.running = false;
    await expect(bindOwnedDeployment(path, endpoint)).rejects.toThrow("container/image");
  });
  it.each(["missing", "extra"])("rejects %s runtime files", async (kind) => {
    const { path, actual } = await fixture();
    actual.inventory =
      kind === "missing" ? actual.inventory.replace(`${assembly}\n`, "") : `${actual.inventory}/managed/extra.dll\n`;
    await expect(bindOwnedDeployment(path, endpoint)).rejects.toThrow("missing or extra");
  });
  it.each([assembly, runtimeConfig, executable, "/managed/libcoreclr.so"])(
    "rejects changed bytes in %s",
    async (name) => {
      const { path, actual } = await fixture();
      actual.hashes = actual.hashes.replace(`${hash(name)}  ${name}`, `${"0".repeat(64)}  ${name}`);
      await expect(bindOwnedDeployment(path, endpoint)).rejects.toThrow("closure bytes differ");
    },
  );
  it("rejects an altered manifest", async () => {
    const { path, actual } = await fixture();
    actual.manifestBody += "extra";
    await expect(bindOwnedDeployment(path, endpoint)).rejects.toThrow("closure manifest differs");
  });
  it("rejects a manifest with duplicate or missing entries even if its digest is declared", async () => {
    const { path, actual, identity } = await fixture();
    actual.manifestBody += actual.manifestBody;
    identity.closureManifestSha256 = hash(actual.manifestBody);
    await writeFile(path, JSON.stringify(identity));
    await expect(bindOwnedDeployment(path, endpoint)).rejects.toThrow("every declared file");
  });
  it.each(["/managed/../secret", "/other/runtime", "/managed/a\nb", "/managed//file"])(
    "rejects unsafe closure path %j before Docker access",
    async (name) => {
      const { path, identity } = await fixture();
      identity.closureFiles[name] = "d".repeat(64);
      await writeFile(path, JSON.stringify(identity));
      await expect(bindOwnedDeployment(path, endpoint)).rejects.toThrow("Invalid owned managed");
      expect(docker).not.toHaveBeenCalled();
    },
  );
  it("rejects symlinks outside the closed regular-file runtime", async () => {
    const { path, actual } = await fixture();
    actual.links = "/managed/runtime-link\n";
    await expect(bindOwnedDeployment(path, endpoint)).rejects.toThrow("symbolic links");
  });
  it("rejects a missing hostfxr binding before Docker access", async () => {
    const { path, identity } = await fixture();
    identity.closureFiles = Object.fromEntries(
      Object.entries(identity.closureFiles).filter(([name]) => !name.endsWith("/libhostfxr.so")),
    );
    await writeFile(path, JSON.stringify(identity));
    await expect(bindOwnedDeployment(path, endpoint)).rejects.toThrow("Invalid owned managed");
    expect(docker).not.toHaveBeenCalled();
  });
  it("rejects native identity or qualification claims on a managed receipt", async () => {
    const { path, identity } = await fixture();
    await writeFile(path, JSON.stringify({ ...identity, nativeBinarySha256: "d".repeat(64) }));
    await expect(bindOwnedDeployment(path, endpoint)).rejects.toThrow("Invalid owned managed");
    expect(docker).not.toHaveBeenCalled();
  });
  it.each(["releaseQualification", "securityQualification", "sourceDirty"] as const)(
    "rejects an affirmative %s claim before Docker access",
    async (field) => {
      const { path, identity } = await fixture();
      identity[field] = true;
      await writeFile(path, JSON.stringify(identity));
      await expect(bindOwnedDeployment(path, endpoint)).rejects.toThrow("Invalid owned managed");
      expect(docker).not.toHaveBeenCalled();
    },
  );
  it("rejects a non-loopback endpoint before Docker access", async () => {
    const { path, identity } = await fixture();
    identity.endpoint = "https://foreign.example";
    await writeFile(path, JSON.stringify(identity));
    await expect(bindOwnedDeployment(path, identity.endpoint)).rejects.toThrow("Invalid owned managed");
    expect(docker).not.toHaveBeenCalled();
  });
  it("detects changed runtime bytes during after-observation revalidation", async () => {
    const { path, actual } = await fixture();
    const bound = await bindOwnedDeployment(path, endpoint);
    actual.hashes = actual.hashes.replace(hash(assembly), "0".repeat(64));
    await expect(bound.verify()).rejects.toThrow("closure bytes differ");
  });
  it("refuses a receipt changed while checks were running", async () => {
    const { path } = await fixture();
    const original = docker.getMockImplementation();
    docker.mockImplementation(async (args: string[]) => {
      const result = await original?.(args);
      if (args[2] === "sha256sum") await writeFile(path, "{}");
      return result;
    });
    await expect(bindOwnedDeployment(path, endpoint)).rejects.toThrow("receipt changed");
  });
});
