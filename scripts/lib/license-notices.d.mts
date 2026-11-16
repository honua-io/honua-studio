import type { Plugin } from "vite";

export function collectLicenseNotices(moduleIds: Iterable<string>, options?: { vendored?: string }): string;
export function licenseNotices(root?: string): Plugin;
