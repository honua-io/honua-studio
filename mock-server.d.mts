/**
 * Type declaration for mock-server.mjs, consulted only by `tsc --noEmit`
 * (test/mock-server-oidc.test.ts imports the real .mjs at runtime via
 * vitest/vite-node; TypeScript without `allowJs` needs a declaration file to
 * type-check that import).
 */
import type http from "node:http";

export declare const OIDC_CLIENT_ID: string;

export declare function startMockServer(options?: { port?: number }): Promise<{
  server: http.Server;
  url: string;
  close: () => Promise<void>;
}>;

export declare function mintFixtureAccessToken(options?: { issuer?: string; ttlSeconds?: number }): string;

/** honua-studio#23: the generated fixture geometry served at `/ogc/collections/{id}/items`. `undefined` for a collection this fixture has no features for (e.g. the raster `hi-imagery`). */
export declare function fixtureFeatureCollection(
  collectionId: string,
  limit?: number,
): { type: "FeatureCollection"; features: unknown[]; numberMatched: number; numberReturned: number } | undefined;
