import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
const execute = promisify(execFile);
const digest = (value) => createHash("sha256").update(value).digest("hex");

/** Read-only identity checks for the explicitly owned loopback Docker diagnostic. */
export async function bindOwnedDeployment(path, endpoint) {
  if (!path) throw new Error("Style proof requires HONUA_CORPUS_DEPLOYMENT_RECEIPT.");
  const raw = await readFile(path, "utf8");
  const identity = JSON.parse(raw);
  const url = new URL(endpoint);
  if (
    identity.schemaVersion !== "honua.owned-native-diagnostic.v1" ||
    identity.endpoint !== endpoint ||
    identity.sourceDirty !== false ||
    identity.releaseQualification !== false ||
    !/^[a-f0-9]{40}$/.test(identity.sourceSha) ||
    !/^[a-f0-9]{64}$/.test(identity.containerId) ||
    !/^sha256:[a-f0-9]{64}$/.test(identity.imageId) ||
    !/^[a-f0-9]{64}$/.test(identity.nativeBinarySha256) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error("Invalid owned deployment binding.");
  const docker = async (args) => (await execute("docker", args, { timeout: 10000, maxBuffer: 1024 * 1024 })).stdout;
  const verify = async () => {
    if ((await readFile(path, "utf8")) !== raw) throw new Error("Deployment receipt changed during observation.");
    // Select only identity fields: raw Docker inspection includes secrets in environment variables.
    const inspected = JSON.parse(
      await docker([
        "inspect",
        "--format",
        "[{{json .Id}},{{json .Image}},{{json .State.Running}},{{json .NetworkSettings.Ports}}]",
        identity.containerId,
      ]),
    );
    if (!inspected) throw new Error("Could not read owned container identity.");
    const [containerId, imageId, running, ports] = inspected;
    const bindings = Object.values(ports).flat().filter(Boolean);
    if (
      containerId !== identity.containerId ||
      imageId !== identity.imageId ||
      running !== true ||
      !bindings.some(
        (binding) => ["127.0.0.1", "::1"].includes(binding.HostIp) && binding.HostPort === (url.port || "80"),
      )
    )
      throw new Error("Actual owned container/image/endpoint differs from deployment receipt.");
    const labels = JSON.parse(await docker(["image", "inspect", "--format", "{{json .Config.Labels}}", imageId]));
    const sourceSha = labels["io.honua.diagnostic.source"] ?? labels["org.opencontainers.image.revision"];
    const binarySha256 = (await docker(["exec", containerId, "sha256sum", "/app/Honua.Server"])).trim().split(/\s/)[0];
    if (sourceSha !== identity.sourceSha || binarySha256 !== identity.nativeBinarySha256)
      throw new Error("Actual owned server source/binary differs from deployment receipt.");
    return { observedAt: new Date().toISOString(), containerId, imageId, sourceSha, binarySha256, bindings };
  };
  const before = await verify();
  return { identity: { receipt: identity, rawReceipt: raw, receiptSha256: digest(raw), before }, verify };
}
