export const liveApprovalEnvironmentNames = {
  consoleUrl: "HONUA_LIVE_CONSOLE_URL",
  profileId: "HONUA_LIVE_CONSOLE_PROFILE_ID",
  idpOrigin: "HONUA_LIVE_APPROVER_IDP_ORIGIN",
  username: "HONUA_LIVE_APPROVER_USERNAME",
  password: "HONUA_LIVE_APPROVER_PASSWORD",
};

/** The static Console bundle is served under /console/; the retired server-hosted Console served the root. */
export function isStaticConsole(consoleUrl) {
  return new URL(consoleUrl).pathname.replace(/\/$/, "").endsWith("/console");
}

/** Only the server-hosted Console needs an environment profile id for its server sign-in route. */
function requiredApprovalSettings(environment) {
  const names = Object.entries(liveApprovalEnvironmentNames);
  const consoleUrl = environment[liveApprovalEnvironmentNames.consoleUrl];
  if (consoleUrl && URL.canParse(consoleUrl) && isStaticConsole(consoleUrl))
    return names.filter(([key]) => key !== "profileId");
  return names;
}

export function liveApprovalConfigured(environment = process.env) {
  return requiredApprovalSettings(environment).every(([, name]) => Boolean(environment[name]));
}

export function liveApprovalConfiguration(environment = process.env) {
  const configuration = {};
  for (const [key, name] of requiredApprovalSettings(environment)) {
    if (!environment[name]) throw new Error(`${name} is required for Console publication approval.`);
    configuration[key] = environment[name];
  }
  for (const key of ["consoleUrl", "idpOrigin"]) validateApprovalUrl(key, configuration[key]);
  return configuration;
}

/** Anonymous audience links: the static bundle reads the server's native route through the same edge. */
export function publishedRouteLinks(consoleUrl, route) {
  const base = consoleUrl.replace(/\/$/, "");
  const definition = isStaticConsole(base)
    ? `${new URL(base).origin}/api/v1/studio/published${route}`
    : `${base}/api/studio/viewer/published${route}`;
  return { definition, map: `${base}/maps/published${route}` };
}

export function validateApprovalUrl(key, value) {
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
  const pins = [];
  for (const name of ["HONUA_LIVE_APPROVER_IDP_SPKI", "HONUA_LIVE_CONSOLE_SPKI"]) {
    const pin = environment[name];
    if (!pin) continue;
    if (!/^[A-Za-z0-9+/]{43}=$/.test(pin)) throw new Error(`${name} must be a SHA256 SPKI pin.`);
    pins.push(pin);
  }
  return pins.length ? [`--ignore-certificate-errors-spki-list=${pins.join(",")}`] : [];
}
