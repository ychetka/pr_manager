import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContentItem } from "../model/contract.js";
import { SqliteStore } from "../store/sqlite.js";
import { type CollectOutcome, collectMetrics, type PlatformCollector } from "./collector.js";
import { type FetchLike, VkCollector, type VkWallPost } from "./vk.js";

const FIXED_NOW = new Date("2026-04-02T08:30:00.000Z");

const stores: SqliteStore[] = [];

function memStore(): SqliteStore {
  const s = new SqliteStore(":memory:");
  s.migrate();
  stores.push(s);
  return s;
}

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
  vi.unstubAllEnvs();
});

function makeItem(over: Partial<ContentItem> = {}): ContentItem {
  return {
    id: "item-1",
    source_kind: "n8n",
    status: "published",
    platform_refs: ["vk"],
    published_urls: ["https://vk.com/wall29642349_300"],
    objective: "proof",
    timestamps: { created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
    ...over,
  };
}

function vkItem(ref: string, counts: { views?: number; likes?: number; comments?: number } = {}) {
  const [owner, post] = ref.split("_").map(Number);
  const item: VkWallPost = { id: post, owner_id: owner };
  if (counts.views !== undefined) {
    item.views = { count: counts.views };
  }
  if (counts.likes !== undefined) {
    item.likes = { count: counts.likes };
  }
  if (counts.comments !== undefined) {
    item.comments = { count: counts.comments };
  }
  return item;
}

interface MockFetch {
  fetch: FetchLike;
  calls: string[][];
}

function mockFetch(handler: (posts: string[]) => unknown): MockFetch {
  const calls: string[][] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const params = new URLSearchParams(String(init?.body ?? ""));
    const posts = (params.get("posts") ?? "").split(",").filter((p) => p !== "");
    calls.push(posts);
    return new Response(JSON.stringify(handler(posts)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fetchImpl, calls };
}

function vkCollector(fetch: FetchLike, over: Record<string, unknown> = {}): VkCollector {
  return new VkCollector({ token: "t", fetch, sleep: () => Promise.resolve(), ...over });
}

describe("collectMetrics", () => {
  it("GWT-1: stores a MetricSnapshot with views/likes/comments for a published vk item", async () => {
    const store = memStore();
    store.upsertContentItem(makeItem());
    const mock = mockFetch((posts) => ({
      response: { items: posts.map((ref) => vkItem(ref, { views: 42, likes: 7, comments: 3 })) },
    }));

    const result = await collectMetrics(store, {
      collectors: [vkCollector(mock.fetch)],
      now: () => FIXED_NOW,
    });

    expect(result.collected).toBe(1);
    expect(result.errored).toEqual([]);
    const [snap] = store.metricsFor("item-1");
    expect(snap).toMatchObject({
      item_id: "item-1",
      platform: "vk",
      ts: "2026-04-02T08:30:00.000Z",
      views: 42,
      likes: 7,
      comments: 3,
    });
    expect(snap?.raw).toMatchObject({ owner_id: 29642349, id: 300 });
  });

  it("moves a collected published item to measured; errored items stay published", async () => {
    const store = memStore();
    store.upsertContentItem(makeItem({ id: "ok", published_urls: ["https://vk.com/wall1_1"] }));
    store.upsertContentItem(makeItem({ id: "bad", published_urls: ["https://vk.com/wall1_2"] }));
    const mock = mockFetch((posts) =>
      posts[0] === "1_1"
        ? { response: { items: [vkItem("1_1", { views: 5 })] } }
        : { error: { error_code: 5, error_msg: "User authorization failed" } },
    );

    const result = await collectMetrics(store, {
      collectors: [vkCollector(mock.fetch, { batchSize: 1 })],
      now: () => FIXED_NOW,
    });

    expect(store.getById("ok").status).toBe("measured");
    expect(store.getById("bad").status).toBe("published");
    expect(result.errored.map((e) => e.item_id)).toEqual(["bad"]);
  });

  it("re-collects items already in measured status", async () => {
    const store = memStore();
    const published = makeItem({ id: "m" });
    store.upsertContentItem({ ...published, status: "measured" });
    const mock = mockFetch((posts) => ({
      response: { items: posts.map((ref) => vkItem(ref, { views: 1 })) },
    }));

    const result = await collectMetrics(store, {
      collectors: [vkCollector(mock.fetch)],
      now: () => FIXED_NOW,
    });
    expect(result.collected).toBe(1);
    expect(store.metricsFor("m")).toHaveLength(1);
  });

  it("GWT-3: no published/measured items -> no-op result, collector never runs", async () => {
    const store = memStore();
    store.upsertContentItem(makeItem({ status: "draft", published_urls: [] }));
    let ran = false;
    const stub: PlatformCollector = {
      platform: "vk",
      collect: () => {
        ran = true;
        return Promise.resolve([] as CollectOutcome[]);
      },
    };
    const result = await collectMetrics(store, { collectors: [stub] });
    expect(ran).toBe(false);
    expect(result).toEqual({ collected: 0, skipped: [], errored: [], warnings: [] });
  });

  it("GWT-4: an auth error lands in errored while other items are still processed", async () => {
    const store = memStore();
    store.upsertContentItem(
      makeItem({ id: "auth-fail", published_urls: ["https://vk.com/wall1_1"] }),
    );
    store.upsertContentItem(makeItem({ id: "fine", published_urls: ["https://vk.com/wall1_2"] }));
    const mock = mockFetch((posts) =>
      posts[0] === "1_1"
        ? { error: { error_code: 5, error_msg: "User authorization failed" } }
        : { response: { items: posts.map((ref) => vkItem(ref, { views: 9 })) } },
    );

    const result = await collectMetrics(store, {
      collectors: [vkCollector(mock.fetch, { batchSize: 1 })],
      now: () => FIXED_NOW,
    });

    expect(result.collected).toBe(1);
    expect(result.errored).toEqual([
      {
        item_id: "auth-fail",
        code: "metrics_auth",
        message: "vk error 5: User authorization failed",
      },
    ]);
    expect(store.metricsFor("fine")).toHaveLength(1);
    expect(store.metricsFor("auth-fail")).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("metrics_auth"))).toBe(true);
  });

  it("GWT-2: a fully rate-limited run reports errored (metrics_upstream), not skipped", async () => {
    const store = memStore();
    store.upsertContentItem(makeItem());
    const mock = mockFetch(() => ({ error: { error_code: 9, error_msg: "Flood control" } }));

    const result = await collectMetrics(store, {
      collectors: [vkCollector(mock.fetch)],
      now: () => FIXED_NOW,
    });

    expect(result.collected).toBe(0);
    expect(result.skipped).toEqual([]);
    expect(result.errored).toEqual([
      {
        item_id: "item-1",
        code: "metrics_upstream",
        message: "post 29642349_300: vk error 9: Flood control",
      },
    ]);
    expect(result.warnings.some((w) => w.includes("metrics_upstream"))).toBe(true);
    expect(store.getById("item-1").status).toBe("published"); // retried next run
  });

  it("warns and ignores collector outcomes for items it never dispatched", async () => {
    const store = memStore();
    store.upsertContentItem(makeItem());
    const rogue: PlatformCollector = {
      platform: "vk",
      collect: () =>
        Promise.resolve([
          { kind: "skip", item_id: "ghost", reason: "not dispatched" },
          { kind: "skip", item_id: "item-1", reason: "deliberate" },
        ]),
    };

    const result = await collectMetrics(store, { collectors: [rogue] });

    expect(result.skipped).toEqual([{ item_id: "item-1", reason: "deliberate" }]);
    expect(result.errored).toEqual([]);
    expect(result.warnings.some((w) => w.includes("ghost"))).toBe(true);
  });

  it("surfaces a missing VK_TOKEN as per-item metrics_auth errors, fetch untouched", async () => {
    vi.stubEnv("VK_TOKEN", "");
    const store = memStore();
    store.upsertContentItem(makeItem());
    const mock = mockFetch(() => ({}));

    const result = await collectMetrics(store, {
      collectors: [new VkCollector({ fetch: mock.fetch })],
      now: () => FIXED_NOW,
    });

    expect(mock.calls).toHaveLength(0);
    expect(result.collected).toBe(0);
    expect(result.errored).toEqual([
      {
        item_id: "item-1",
        code: "metrics_auth",
        message: "VK_TOKEN is not set - cannot run the VK metrics collector",
      },
    ]);
    expect(result.warnings.some((w) => w.includes("VK_TOKEN"))).toBe(true);
  });

  it("skips items with no platform_refs or no registered collector", async () => {
    const store = memStore();
    store.upsertContentItem(makeItem({ id: "no-refs", platform_refs: [], published_urls: [] }));
    store.upsertContentItem(makeItem({ id: "li-only", platform_refs: ["linkedin"] }));

    const result = await collectMetrics(store, {
      collectors: [vkCollector(mockFetch(() => ({})).fetch)],
    });

    expect(result.collected).toBe(0);
    expect(result.skipped).toEqual([
      { item_id: "no-refs", reason: "no platform_refs" },
      { item_id: "li-only", reason: "no collector for platform_refs [linkedin]" },
    ]);
    expect(result.warnings.some((w) => w.includes("linkedin"))).toBe(true);
  });

  it("counts an item absent from collector outcomes as skipped", async () => {
    const store = memStore();
    store.upsertContentItem(makeItem());
    const empty: PlatformCollector = {
      platform: "vk",
      collect: () => Promise.resolve([]),
    };
    const result = await collectMetrics(store, { collectors: [empty] });
    expect(result.skipped).toEqual([
      { item_id: "item-1", reason: "collector returned no outcome" },
    ]);
  });
});
