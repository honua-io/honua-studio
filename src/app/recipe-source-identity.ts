import type { CatalogDataset } from "../client/studio-client.js";
import { canonicalCompositionJson } from "../composition/model.js";
import { runtimeMcpBaseUrl } from "../runtime-config.js";

type ServiceLocator = NonNullable<CatalogDataset["locator"]> & { readonly url: string };

/** The FeatureServer service URL, or undefined when it carries credentials, a query or encoded separators. */
function featureServerUrl(locator: ServiceLocator): URL | undefined {
  const url = new URL(locator.url, document.baseURI);
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /%(?:2f|5c|25)/i.test(url.pathname)
  )
    return undefined;
  url.pathname = url.pathname
    .replace(/\/$/, "")
    .replace(new RegExp(`/FeatureServer/${locator.layerId}$`, "i"), "/FeatureServer");
  return url;
}

/** Same-origin service paths under the catalog root or the verified deployment path compare as catalog paths. */
function rebaseOntoCatalogRoot(url: URL, verifiedSourceBase: string | undefined): void {
  const documentOrigin = new URL(document.baseURI).origin;
  const catalogRoot = new URL(runtimeMcpBaseUrl() || "/", document.baseURI);
  const roots = [
    catalogRoot,
    ...(verifiedSourceBase === undefined ? [] : [new URL(verifiedSourceBase || "/", document.baseURI)]),
  ];
  if (catalogRoot.origin !== documentOrigin) return;
  for (const root of roots) {
    const prefix = root.pathname.replace(/\/$/, "");
    if (
      root.origin === documentOrigin &&
      url.origin === documentOrigin &&
      url.pathname.startsWith(`${prefix}/rest/services/`)
    ) {
      url.pathname = `${catalogRoot.pathname.replace(/\/$/, "")}${url.pathname.slice(prefix.length)}`;
      return;
    }
  }
}

/** A canonical identity for a published FeatureServer source, so two listings of it compare equal. */
export function recipeSourceIdentity(source: CatalogDataset, verifiedSourceBase?: string): string | undefined {
  const locator = source.locator;
  if (
    !locator ||
    typeof locator.url !== "string" ||
    typeof locator.serviceId !== "string" ||
    !Number.isSafeInteger(locator.layerId)
  )
    return undefined;
  try {
    const url = featureServerUrl(locator as ServiceLocator);
    if (!url) return undefined;
    rebaseOntoCatalogRoot(url, verifiedSourceBase);
    return canonicalCompositionJson({
      id: source.id,
      protocol: source.protocol,
      locator: { ...locator, url: url.href },
    });
  } catch {
    return undefined;
  }
}
