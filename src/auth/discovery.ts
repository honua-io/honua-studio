/**
 * OIDC discovery-document fetch (honua-studio#4 REQ-001).
 *
 * honua-server itself never issues tokens — it delegates identity to an
 * operator-configured external OIDC provider (`Oidc__Generic__Authority`,
 * see honua-server's docs/guides/secure/authentication.md) and validates
 * bearer tokens against that provider's JWKS. Studio therefore talks to the
 * *issuer*, not to honua-server, for the interactive login leg: this module
 * fetches the standard `.well-known/openid-configuration` document so the
 * authorize/token/revoke endpoints never need to be hand-configured.
 */

export interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  jwks_uri?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export class OidcDiscoveryError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "OidcDiscoveryError";
  }
}

function discoveryUrl(issuer: string): string {
  const base = issuer.endsWith("/") ? issuer : `${issuer}/`;
  return new URL(".well-known/openid-configuration", base).toString();
}

/** Fetch and validate the discovery document at `issuer`. */
export async function discoverOidc(issuer: string, fetchFn: typeof fetch = fetch): Promise<OidcDiscoveryDocument> {
  const url = discoveryUrl(issuer);
  let response: Response;
  try {
    response = await fetchFn(url, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new OidcDiscoveryError(`Could not reach the OIDC issuer's discovery document at ${url}.`, error);
  }
  if (!response.ok) {
    throw new OidcDiscoveryError(`OIDC discovery at ${url} responded ${response.status}.`);
  }
  const document = (await response.json()) as Partial<OidcDiscoveryDocument>;
  if (!document.authorization_endpoint || !document.token_endpoint) {
    throw new OidcDiscoveryError(
      `OIDC discovery document at ${url} is missing authorization_endpoint / token_endpoint.`,
    );
  }
  return document as OidcDiscoveryDocument;
}
