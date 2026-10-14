import { createHash, generateKeyPairSync, sign } from "node:crypto";

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

// Ephemeral fixture identity. Never a release key or evidence of a hosted model.
export function createFixtureTranscriptSigner() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const rawKey = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const keyId = `studio-fixture-${digest(rawKey).slice(0, 16)}`;
  const manifest = {
    requiredForCertification: true,
    keys: [
      {
        keyId,
        algorithm: "Ed25519",
        publicKey: rawKey.toString("base64"),
        fingerprint: `sha256:${digest(rawKey)}`,
        revoked: false,
      },
    ],
  };
  return {
    manifest,
    sign(request, events) {
      const issuedAt = new Date();
      const transcript = Buffer.from(
        canonical({
          ...request.certification,
          keyId,
          provider: request.provider ?? "byom-preview",
          model: events.find((event) => event.type === "messageStart")?.model,
          issuedAt: issuedAt.toISOString(),
          expiresAt: new Date(issuedAt.valueOf() + 60_000).toISOString(),
          request: Buffer.from(JSON.stringify(request)).toString("base64"),
          providerEvents: Buffer.from(JSON.stringify(events)).toString("base64"),
        }),
      );
      return {
        type: "transcriptProvenance",
        provenance: {
          schemaVersion: "honua.studio-ai.transcript.v1",
          canonicalization: "honua-canonical-json-v1",
          digestAlgorithm: "sha-256",
          signatureAlgorithm: "Ed25519",
          keyId,
          canonicalTranscript: transcript.toString("base64"),
          transcriptDigest: digest(transcript),
          signature: sign(null, transcript, privateKey).toString("base64"),
        },
      };
    },
  };
}
