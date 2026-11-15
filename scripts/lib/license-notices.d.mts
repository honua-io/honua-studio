import type { Plugin } from "vite";

export function collectLicenseNotices(moduleIds: Iterable<string>): string;
export function licenseNotices(): Plugin;
