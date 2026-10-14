import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const hashPattern = /^[a-f0-9]{64}$/;
const assembly = "/managed/Honua.Server.dll";
const runtimeConfig = "/managed/Honua.Server.runtimeconfig.json";
const executable = "/diagnostic-dotnet/dotnet";
const manifest = "/diagnostic/managed-closure.sha256";
const command = [executable, "exec", assembly];
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const safePath = (path) =>
  /^\/(managed|diagnostic-dotnet)\/[A-Za-z0-9_.+/-]+$/.test(path) &&
  path
    .split("/")
    .slice(2)
    .every((part) => part !== "" && part !== "." && part !== "..");

/** Managed functional diagnostics are separate from native and release qualification. */
export async function bindManagedDeployment(path, endpoint, raw, identity) {
  const url = new URL(endpoint);
  const files = identity.closureFiles;
  if (
    identity.schemaVersion !== "honua.owned-managed-diagnostic.v1" ||
    identity.endpoint !== endpoint ||
    identity.sourceDirty !== false ||
    identity.releaseQualification !== false ||
    identity.securityQualification !== false ||
    identity.syntheticData !== true ||
    identity.runtimeKind !== "managed-jit" ||
    identity.nativeBinarySha256 !== undefined ||
    !/^[a-f0-9]{40}$/.test(identity.sourceSha) ||
    !/^[a-f0-9]{64}$/.test(identity.containerId) ||
    !/^sha256:[a-f0-9]{64}$/.test(identity.imageId) ||
    identity.managedAssemblyPath !== assembly ||
    identity.runtimeConfigPath !== runtimeConfig ||
    identity.runtimeExecutable !== executable ||
    identity.closureManifestPath !== manifest ||
    !same(identity.entrypoint, command) ||
    !same(identity.cmd, []) ||
    !hashPattern.test(identity.managedAssemblySha256) ||
    !hashPattern.test(identity.runtimeConfigSha256) ||
    !hashPattern.test(identity.closureManifestSha256) ||
    !files ||
    typeof files !== "object" ||
    Array.isArray(files) ||
    Object.keys(files).length > 10000 ||
    Object.entries(files).some(([name, hash]) => !safePath(name) || !hashPattern.test(hash)) ||
    files[assembly] !== identity.managedAssemblySha256 ||
    files[runtimeConfig] !== identity.runtimeConfigSha256 ||
    !files[executable] ||
    !Object.keys(files).some((name) => /^\/diagnostic-dotnet\/host\/fxr\/[^/]+\/libhostfxr\.so$/.test(name)) ||
    !files["/managed/libcoreclr.so"] ||
    !files["/managed/libhostpolicy.so"] ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Invalid owned managed deployment binding.");
  const names = Object.keys(files).sort();
  const docker = async (args, timeout = 10000) =>
    (await execute("docker", args, { timeout, maxBuffer: 4 * 1024 * 1024 })).stdout;
  const verify = async () => {
    if ((await readFile(path, "utf8")) !== raw) throw new Error("Deployment receipt changed during observation.");
    // Never inspect environment variables or other credential-bearing container configuration.
    const [containerId, imageId, running, ports, actualPath, args, entrypoint, cmd] = JSON.parse(
      await docker([
        "inspect",
        "--format",
        "[{{json .Id}},{{json .Image}},{{json .State.Running}},{{json .NetworkSettings.Ports}},{{json .Path}},{{json .Args}},{{json .Config.Entrypoint}},{{json .Config.Cmd}}]",
        identity.containerId,
      ]),
    );
    const bindings = Object.values(ports ?? {})
      .flat()
      .filter(Boolean);
    if (
      containerId !== identity.containerId ||
      imageId !== identity.imageId ||
      running !== true ||
      !bindings.some(
        (binding) =>
          ["127.0.0.1", "::1"].includes(binding.HostIp) &&
          binding.HostPort === (url.port || (url.protocol === "https:" ? "443" : "80")),
      ) ||
      actualPath !== executable ||
      !same(args, command.slice(1)) ||
      !same(entrypoint, command) ||
      !(cmd === null || same(cmd, []))
    )
      throw new Error("Actual managed container/image/endpoint/entrypoint differs from deployment receipt.");
    const labels = JSON.parse(await docker(["image", "inspect", "--format", "{{json .Config.Labels}}", imageId]));
    const sourceSha = labels?.["io.honua.diagnostic.source"] ?? labels?.["org.opencontainers.image.revision"];
    if (sourceSha !== identity.sourceSha) throw new Error("Actual managed source differs from deployment receipt.");
    const manifestBody = await docker(["exec", containerId, "cat", manifest]);
    if (digest(manifestBody) !== identity.closureManifestSha256)
      throw new Error("Actual managed closure manifest differs from deployment receipt.");
    const expectedLines = names.map((name) => `${files[name]}  ${name}`).sort();
    if (!same(manifestBody.trimEnd().split("\n").sort(), expectedLines))
      throw new Error("Managed closure manifest does not match every declared file.");
    const links = await docker(["exec", containerId, "find", "/managed", "/diagnostic-dotnet", "-type", "l"]);
    if (links.trim()) throw new Error("Managed runtime closure contains symbolic links.");
    const inventory = await docker(["exec", containerId, "find", "/managed", "/diagnostic-dotnet", "-type", "f"]);
    if (!same(inventory.trimEnd().split("\n").sort(), names))
      throw new Error("Actual managed closure has missing or extra files.");
    // Hash the pinned file list directly: a changed manifest cannot redirect the checksum command.
    const actualHashes = await docker(["exec", containerId, "sha256sum", "--", ...names], 60000);
    if (!same(actualHashes.trimEnd().split("\n").sort(), expectedLines))
      throw new Error("Actual managed assembly/runtime closure bytes differ from deployment receipt.");
    if ((await readFile(path, "utf8")) !== raw) throw new Error("Deployment receipt changed during observation.");
    return {
      observedAt: new Date().toISOString(),
      runtimeKind: "managed-jit",
      containerId,
      imageId,
      sourceSha,
      entrypoint: command,
      bindings,
      managedAssemblySha256: files[assembly],
      runtimeConfigSha256: files[runtimeConfig],
      closureManifestSha256: digest(manifestBody),
      verifiedFileCount: names.length,
      releaseQualification: false,
      securityQualification: false,
    };
  };
  const before = await verify();
  return { identity: { receipt: identity, rawReceipt: raw, receiptSha256: digest(raw), before }, verify };
}
