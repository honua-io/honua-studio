import { describe, expect, it } from "vitest";
import { projectPublicationReceipt } from "../../src/chat/share-preview.js";

describe("server publication receipts", () => {
  it("resolves a published server-relative URL against the configured server", () => {
    expect(
      projectPublicationReceipt(
        { status: "Published", humanConfirmationRequired: false, shareUrl: "/apps/parcels" },
        "https://honua.example/api",
      ),
    ).toEqual({
      text: "Shared — https://honua.example/apps/parcels",
      publicationUrl: "https://honua.example/apps/parcels",
    });
  });

  it("keeps pending publication distinct even if the payload includes a URL", () => {
    const note = projectPublicationReceipt(
      { status: "AwaitingApproval", humanConfirmationRequired: true, shareUrl: "https://honua.example/apps/parcels" },
      "https://honua.example",
    );
    expect(note?.publicationUrl).toBeUndefined();
    expect(note?.text).toContain("Nothing has been published");
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,published",
    "//other.example/map",
    "/\\other.example/map",
    "https://user:secret@host/map",
    undefined,
  ])("does not display an unsafe or absent share URL: %s", (shareUrl) => {
    const note = projectPublicationReceipt(
      { status: "Published", humanConfirmationRequired: false, shareUrl },
      "https://honua.example",
    );
    expect(note?.publicationUrl).toBeUndefined();
    expect(note?.text).toBe("Published, but the server did not return a verified link.");
  });

  it("does not infer publication from inconsistent or unknown receipts", () => {
    expect(
      projectPublicationReceipt({ status: "Published", humanConfirmationRequired: true }, "https://honua.example"),
    ).toBeUndefined();
    expect(
      projectPublicationReceipt(
        { status: "Executing", shareUrl: "https://honua.example/map" },
        "https://honua.example",
      ),
    ).toBeUndefined();
  });
});
