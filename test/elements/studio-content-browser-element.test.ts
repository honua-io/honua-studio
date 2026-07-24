// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioContentBrowserElement } from "../../src/elements/studio-content-browser-element.js";
import type { HonuaStudioOpenItemDetail } from "../../src/elements/types.js";
import type {
  StudioContentItemListResponse,
  StudioContentItemQuery,
  StudioPackageDraftListResponse,
  StudioPackageDraftQuery,
} from "../../src/lifecycle/lifecycle-types.js";

registerAllStudioElements();

function fakeItem(overrides: Partial<StudioContentItemListResponse["items"][number]> = {}) {
  return {
    itemId: "item-1",
    packageKey: "parcels-overview",
    family: "map" as const,
    state: "current" as const,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function fakeDraft(overrides: Partial<StudioPackageDraftListResponse["items"][number]> = {}) {
  return {
    draftId: "draft-1",
    itemId: "item-1",
    packageKey: "wells-below-threshold",
    family: "query" as const,
    envelope: { family: "query" as const, schemaVersion: "1.0" },
    generation: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

class FakeLifecycleClient {
  public listContentItemsCalls: StudioContentItemQuery[] = [];
  public listPackageDraftsCalls: StudioPackageDraftQuery[] = [];
  public itemsResponse: StudioContentItemListResponse = { items: [fakeItem()], total: 1, nextCursor: null };
  public draftsResponse: StudioPackageDraftListResponse = { items: [fakeDraft()], total: 1, nextCursor: null };

  async listContentItems(query: StudioContentItemQuery = {}): Promise<StudioContentItemListResponse> {
    this.listContentItemsCalls.push(query);
    return this.itemsResponse;
  }

  async listPackageDrafts(query: StudioPackageDraftQuery = {}): Promise<StudioPackageDraftListResponse> {
    this.listPackageDraftsCalls.push(query);
    return this.draftsResponse;
  }
}

function mount(client: FakeLifecycleClient): HonuaStudioContentBrowserElement {
  const el = document.createElement("honua-studio-content-browser") as HonuaStudioContentBrowserElement;
  // FakeLifecycleClient satisfies the structural surface the element reads, not the full StudioLifecycleClient class.
  el.client = client as any;
  document.body.appendChild(el);
  return el;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("<honua-studio-content-browser> (honua-studio#9)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("loads and renders content items + drafts on connect", async () => {
    const client = new FakeLifecycleClient();
    const el = mount(client);
    await flush();

    expect(el.shadowRoot?.querySelector('[data-testid="content-item-row"]')?.textContent).toContain("parcels-overview");
    expect(el.shadowRoot?.querySelector('[data-testid="draft-row"]')?.textContent).toContain("wells-below-threshold");
  });

  it("shows the publication badge for a published item and the pending-publication badge for a draft with proposed intent", async () => {
    const client = new FakeLifecycleClient();
    client.itemsResponse = {
      items: [
        fakeItem({
          state: "published",
          publication: {
            publicationId: "pub-1",
            routeSlug: "studio/parcels-overview",
            routePath: "/api/v1/published/studio/parcels-overview",
            lifecycle: "active",
            activeRevision: 2,
            updatedAt: "2026-01-02T00:00:00Z",
          },
        }),
      ],
      total: 1,
      nextCursor: null,
    };
    client.draftsResponse = {
      items: [fakeDraft({ envelope: { family: "query", schemaVersion: "1.0", publicationIntent: { route: "/x" } } })],
      total: 1,
      nextCursor: null,
    };
    const el = mount(client);
    await flush();

    expect(el.shadowRoot?.querySelector('[data-testid="publication-badge"]')?.textContent).toBe("active");
    expect(el.shadowRoot?.querySelector('[data-testid="pending-publication-badge"]')).toBeTruthy();
  });

  it("changing the family filter re-queries both lists with the selected family", async () => {
    const client = new FakeLifecycleClient();
    const el = mount(client);
    await flush();
    client.listContentItemsCalls = [];
    client.listPackageDraftsCalls = [];

    const select = el.shadowRoot?.querySelector<HTMLSelectElement>('[data-testid="content-browser-family-filter"]');
    expect(select).toBeTruthy();
    if (select) {
      select.value = "map";
      select.dispatchEvent(new Event("change"));
    }
    await flush();

    expect(client.listContentItemsCalls.at(-1)).toMatchObject({ families: ["map"] });
    expect(client.listPackageDraftsCalls.at(-1)).toMatchObject({ families: ["map"] });
  });

  it("changing the state filter re-queries only the content-items list", async () => {
    const client = new FakeLifecycleClient();
    const el = mount(client);
    await flush();
    client.listContentItemsCalls = [];
    client.listPackageDraftsCalls = [];

    const select = el.shadowRoot?.querySelector<HTMLSelectElement>('[data-testid="content-browser-state-filter"]');
    if (select) {
      select.value = "published";
      select.dispatchEvent(new Event("change"));
    }
    await flush();

    expect(client.listContentItemsCalls.at(-1)).toMatchObject({ states: ["published"] });
    expect(client.listPackageDraftsCalls).toHaveLength(0);
  });

  it("typing in the search box debounces before re-querying", async () => {
    vi.useFakeTimers();
    const client = new FakeLifecycleClient();
    const el = mount(client);
    await vi.advanceTimersByTimeAsync(0);
    client.listContentItemsCalls = [];
    client.listPackageDraftsCalls = [];

    const input = el.shadowRoot?.querySelector<HTMLInputElement>('[data-testid="content-browser-search"]');
    expect(input).toBeTruthy();
    if (input) {
      input.value = "wells";
      input.dispatchEvent(new Event("input"));
    }
    // Before the debounce window elapses, no new query yet.
    await vi.advanceTimersByTimeAsync(100);
    expect(client.listContentItemsCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(200);
    expect(client.listContentItemsCalls.at(-1)).toMatchObject({ q: "wells" });
  });

  it("load-more on content items passes the previous nextCursor and appends rows", async () => {
    const client = new FakeLifecycleClient();
    client.itemsResponse = { items: [fakeItem({ itemId: "item-1" })], total: 2, nextCursor: "cursor-abc" };
    const el = mount(client);
    await flush();

    client.itemsResponse = {
      items: [fakeItem({ itemId: "item-2", packageKey: "second-item" })],
      total: 2,
      nextCursor: null,
    };
    const loadMore = el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="content-browser-items-load-more"]');
    expect(loadMore).toBeTruthy();
    loadMore?.click();
    await flush();

    expect(client.listContentItemsCalls.at(-1)).toMatchObject({ cursor: "cursor-abc" });
    const rows = el.shadowRoot?.querySelectorAll('[data-testid="content-item-row"]');
    expect(rows).toHaveLength(2);
    expect(el.shadowRoot?.querySelector('[data-testid="content-browser-items-load-more"]')).toBeFalsy(); // nextCursor now null
  });

  it("clicking Open on a content-item row dispatches honua-studio-open-item with itemId/family/packageKey", async () => {
    const client = new FakeLifecycleClient();
    const el = mount(client);
    await flush();

    const detail = await new Promise<HonuaStudioOpenItemDetail>((resolve) => {
      el.addEventListener("honua-studio-open-item", (event) => resolve((event as CustomEvent).detail), { once: true });
      el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="content-item-open"]')?.click();
    });
    expect(detail).toEqual({ itemId: "item-1", family: "map", packageKey: "parcels-overview" });
  });

  it("clicking Open on a draft row dispatches honua-studio-open-item with draftId/itemId/family/packageKey", async () => {
    const client = new FakeLifecycleClient();
    const el = mount(client);
    await flush();

    const detail = await new Promise<HonuaStudioOpenItemDetail>((resolve) => {
      el.addEventListener("honua-studio-open-item", (event) => resolve((event as CustomEvent).detail), { once: true });
      el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="draft-open"]')?.click();
    });
    expect(detail).toEqual({
      draftId: "draft-1",
      itemId: "item-1",
      family: "query",
      packageKey: "wells-below-threshold",
    });
  });

  it("surfaces a fetch error without throwing", async () => {
    const client = new FakeLifecycleClient();
    client.listContentItems = async () => {
      throw new Error("network down");
    };
    const el = mount(client);
    await flush();

    expect(el.shadowRoot?.querySelector('[data-testid="content-browser-items-error"]')?.textContent).toContain(
      "network down",
    );
  });

  it("never calls requestPublish or requestRollback (not part of this element's client surface at all)", async () => {
    const client = new FakeLifecycleClient();
    expect((client as unknown as Record<string, unknown>).requestPublish).toBeUndefined();
    expect((client as unknown as Record<string, unknown>).requestRollback).toBeUndefined();
    mount(client);
    await flush();
  });
});
