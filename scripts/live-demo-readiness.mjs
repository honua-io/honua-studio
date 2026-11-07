import { mkdir, writeFile } from "node:fs/promises";
import { liveReadinessEvidence } from "../test/playwright/live-journey-contract.mjs";

const baseUrl = process.env.HONUA_LIVE_BASE_URL;
const apiKey = process.env.HONUA_LIVE_API_KEY;
if (!baseUrl || !apiKey) throw new Error("Live readiness requires HONUA_LIVE_BASE_URL and HONUA_LIVE_API_KEY.");
const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/studio/ai/capabilities`, {
  headers: { "x-api-key": apiKey, accept: "application/json" },
});
if (!response.ok) throw new Error(`Live capabilities returned HTTP ${response.status}.`);
const { data } = await response.json();
const readiness = liveReadinessEvidence(data, {
  humanApprovalCredentialPresent: Boolean(process.env.HONUA_LIVE_HUMAN_TOKEN),
});
await mkdir(".tmp", { recursive: true });
await writeFile(".tmp/live-readiness.json", `${JSON.stringify(readiness, null, 2)}\n`);
console.log(JSON.stringify(readiness));
