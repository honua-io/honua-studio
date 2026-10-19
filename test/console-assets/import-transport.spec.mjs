import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, sep } from "node:path";
import { expect, test } from "@playwright/test";

// Exercise the built Console entry in Chromium. The HTTP fixture supplies only
// responses: package resolution, hashing, authentication and requests use the
// actual bundled SDK. This does not qualify a live server import journey.
test("Console bundle hashes files and exposes the canonical import transports", async ({ page }) => {
  const root = resolve("dist-console");
  const requests = [];
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname.startsWith("/api/")) {
      requests.push({ path: request.url, method: request.method, authentication: request.headers["x-test-session"] });
      if (pathname.endsWith("/capabilities")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({ chunkBytes: 1048576, maximumFileBytes: 4294967296, importAcceptanceSupported: false }),
        );
      } else {
        response.writeHead(404).end();
      }
      return;
    }
    if (pathname === "/") {
      response
        .writeHead(200, { "Content-Type": "text/html" })
        .end("<!doctype html><title>Console asset qualification</title>");
      return;
    }
    const file = resolve(root, `.${pathname}`);
    if (!file.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const bytes = await readFile(file);
      response.writeHead(200, {
        "Content-Type": pathname.endsWith(".js") ? "text/javascript" : "application/octet-stream",
      });
      response.end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const result = await page.evaluate(async () => {
      const sdk = await import("/console.js");
      let authentication = 0;
      const options = {
        baseUrl: location.origin,
        workspaceId: "original-workspace",
        targetId: "original-target",
        headers: async () => ({ "X-Test-Session": `fresh-${++authentication}` }),
      };
      const reference = { taskId: "original-task", revision: 3, contentHash: "a".repeat(64) };
      const digest = await sdk.hashDatasetImportFile(new Blob(["abc"]));
      const task = await new sdk.DatasetImportTaskClient(options).readTask(reference);
      const capabilities = await new sdk.DatasetImportUploadClient(options).capabilities(reference);
      const submission = await new sdk.DatasetImportSubmissionClient(options).read(reference);
      return { digest, task, capabilities, submission };
    });
    expect(result).toEqual({
      digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      task: null,
      capabilities: { chunkBytes: 1048576, maximumFileBytes: 4294967296, importAcceptanceSupported: false },
      submission: null,
    });
    expect(requests).toHaveLength(3);
    const taskPath = "/api/v1/agent/workspaces/original-workspace/dataset-import-tasks/original-task/versions/3";
    const expectedPaths = [
      taskPath,
      `${taskPath}/upload/capabilities?contentHash=${"a".repeat(64)}`,
      `${taskPath}/submission?contentHash=${"a".repeat(64)}`,
    ];
    for (const [index, request] of requests.entries()) {
      expect(request.method).toBe("GET");
      expect(request.path).toBe(expectedPaths[index]);
      expect(request.authentication).toBe(`fresh-${index + 1}`);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolveClosed) => server.close(resolveClosed));
  }
});
