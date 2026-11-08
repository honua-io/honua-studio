export const liveApprovalEnvironmentNames = {
  consoleUrl: "HONUA_LIVE_CONSOLE_URL",
  profileId: "HONUA_LIVE_CONSOLE_PROFILE_ID",
  idpOrigin: "HONUA_LIVE_APPROVER_IDP_ORIGIN",
  username: "HONUA_LIVE_APPROVER_USERNAME",
  password: "HONUA_LIVE_APPROVER_PASSWORD",
};

export function liveApprovalConfigured(environment = process.env) {
  return Object.values(liveApprovalEnvironmentNames).every((name) => Boolean(environment[name]));
}

export function liveApprovalConfiguration(environment = process.env) {
  const configuration = {};
  for (const [key, name] of Object.entries(liveApprovalEnvironmentNames)) {
    if (!environment[name]) throw new Error(`${name} is required for Console publication approval.`);
    configuration[key] = environment[name];
  }
  for (const key of ["consoleUrl", "idpOrigin"]) validateApprovalUrl(key, configuration[key]);
  return configuration;
}

function validateApprovalUrl(key, value) {
  const url = new URL(value);
  const localConsole =
    key === "consoleUrl" && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!localConsole && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error(
      `${liveApprovalEnvironmentNames[key]} requires HTTPS or a loopback Console URL without credentials, query or fragment.`,
    );
  }
  if (key === "idpOrigin" && url.pathname !== "/") {
    throw new Error("HONUA_LIVE_APPROVER_IDP_ORIGIN must contain only an HTTPS origin.");
  }
}

export function liveApprovalBrowserArguments(environment = process.env) {
  const pin = environment.HONUA_LIVE_APPROVER_IDP_SPKI;
  if (!pin) return [];
  if (!/^[A-Za-z0-9+/]{43}=$/.test(pin)) throw new Error("HONUA_LIVE_APPROVER_IDP_SPKI must be a SHA256 SPKI pin.");
  return [`--ignore-certificate-errors-spki-list=${pin}`];
}
