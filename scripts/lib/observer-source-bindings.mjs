/** Bind trusted host aliases to actual discovery, never substitute supplied runtime locators. */
export function bindObservedSources(sources, discovered, upstream, browserOrigin) {
  const root = new URL(upstream);
  const browser = new URL(browserOrigin);
  const ids = new Set();
  return sources.map((source) => {
    if (typeof source.id !== "string" || !source.id || ids.has(source.id)) throw new Error("Invalid host source id.");
    ids.add(source.id);
    const locator = source.locator ?? source;
    const { serviceId, layerId } = locator;
    if (typeof serviceId !== "string" || !serviceId || !Number.isSafeInteger(layerId) || layerId < 0)
      throw new Error("Host source requires an explicit service/layer identity.");
    for (const key of ["serviceId", "layerId"])
      if (source.locator && source[key] !== undefined && source[key] !== locator[key])
        throw new Error("Conflicting host source identities.");
    const matches = discovered.filter((entry) => {
      if (entry.locator?.layerId !== layerId) return false;
      if (entry.locator.serviceId === serviceId) return true;
      // Historical corpus descriptors used the server's published service name as serviceId.
      // Accept that shape only alongside an exact supplied URL; canonical locator identities never alias.
      if (source.locator || typeof source.url !== "string") return false;
      const path = new URL(entry.locator.url, browser).pathname;
      const match = /^\/rest\/services\/(.+)\/FeatureServer$/.exec(path);
      return match && match[1].split("/").map(decodeURIComponent).join("/") === serviceId;
    });
    const actual = matches[0];
    if (matches.length !== 1 || source.protocol !== actual.protocol || source.geometryType !== actual.geometryType)
      throw new Error(`Host source ${source.id} does not match actual catalog discovery.`);
    const runtime = new URL(actual.locator.url, browser);
    if (runtime.origin !== browser.origin || runtime.username || runtime.password || runtime.search || runtime.hash)
      throw new Error("Discovered locator is outside the actual browser proxy.");
    const expected = new URL(`${root.pathname.replace(/\/$/, "")}${runtime.pathname}`, root.origin);
    for (const value of [source.url, source.locator?.url].filter((value) => value !== undefined)) {
      const declared = new URL(value, root);
      if (
        declared.username ||
        declared.password ||
        declared.search ||
        declared.hash ||
        ![expected.href, `${expected.href}/${layerId}`].includes(declared.href.replace(/\/$/, ""))
      )
        throw new Error("Host source URL does not match actual discovered service/layer.");
    }
    return { ...actual, id: source.id };
  });
}
