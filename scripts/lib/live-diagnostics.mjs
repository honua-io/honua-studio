import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export const approvalObserverPort = 19081;
export const approvalObserverOrigin = `http://qualification-host:${approvalObserverPort}`;

export function diagnosticRedactor({ root = ".tmp/live-compose", environment = process.env, extraValues = [] } = {}) {
  const secrets = Object.entries(environment)
    .filter(([name, value]) => value && /(?:PASSWORD|SECRET|TOKEN|API_KEY|_USERNAME)$/.test(name))
    .map(([, value]) => value)
    .concat(extraValues);
  const directory = join(root, "secrets");
  if (existsSync(directory)) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && /(?:password|api_key|secret|signing_key|master_key|chain_key)$/.test(entry.name)) {
        secrets.push(readFileSync(join(directory, entry.name), "utf8").trim());
      }
    }
  }
  const variants = [...new Set(secrets.filter(Boolean).flatMap((secret) => [secret, encodeURIComponent(secret)]))].sort(
    (left, right) => right.length - left.length,
  );
  return (value) => {
    let text = String(value);
    for (const secret of variants) text = text.replaceAll(secret, "[REDACTED]");
    return text
      .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
      .replace(
        /([?&](?:code|state|session_state|token|access_token|id_token|refresh_token)=)[^\s&"'<>]+/gi,
        "$1[REDACTED]",
      )
      .replace(
        /("(?:apiKey|token|access_token|id_token|refresh_token|password|client_secret|clientSecret|secret|authorization|cookie)"\s*:\s*")(?:\\.|[^"\\])*"/gi,
        '$1[REDACTED]"',
      );
  };
}

export function writeDiagnostic(path, content, redact = diagnosticRedactor()) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, redact(content), { mode: 0o600 });
}

export function collectPlaywrightContexts(source = ".tmp/playwright-output") {
  if (!existsSync(source)) return;
  const redact = diagnosticRedactor();
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === "error-context.md") {
        writeDiagnostic(
          join(".tmp/live-diagnostics/playwright", relative(source, path)),
          readFileSync(path, "utf8"),
          redact,
        );
      }
    }
  }
  visit(source);
}
