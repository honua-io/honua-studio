import { appendFileSync, readFileSync } from "node:fs";

globalThis.fetch = async (url, options) => {
  const fixture = JSON.parse(readFileSync(process.env.STACK_FIXTURE, "utf8"));
  const path = new URL(url).pathname;
  if (/\/healthz\/ready$|\/version.json$|\/\.well-known\/openid-configuration$/.test(path)) return new Response("{}");
  if (!path.startsWith("/api/v1/operations/admin.ai.admission.")) throw new Error("Unexpected external request.");
  appendFileSync(process.env.STACK_REQUESTS, `${JSON.stringify({ path, body: JSON.parse(options.body) })}\n`);
  if (fixture.admissionRefused) return new Response("{}", { status: 403 });
  return Response.json({
    data: {
      status: fixture.admissionFailed ? "Failed" : "Completed",
      ...(fixture.missingAudit ? {} : { auditId: "synthetic-audit" }),
    },
  });
};
