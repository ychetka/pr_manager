import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContentItem } from "../model/contract.js";
import type { CollectContext, CollectOutcome } from "./collector.js";
import {
  type FetchLike,
  METRICS_AUTH,
  parseVkWallRef,
  VK_BATCH_LIMIT,
  VkCollector,
  type VkWallPost,
} from "./vk.js";

const FIXED_NOW = new Date("2026-04-01T12:00:00.000Z");

function ctx(warnings: string[] = []): CollectContext {
  return { now: () => FIXED_NOW, warn: (m) => warnings.push(m) };
}

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
  const item: VkWallPost = { id: post, owner_id: owner, text: "x" };
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
  /** posts list of every call, in order. */
  calls: string[][];
}

/**
 * fetch stub for wall.getById: parses the `posts` param out of the
 * urlencoded request body and delegates the response to `handler`.
 */
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

function okFor(posts: string[]) {
  return { response: { items: posts.map((ref) => vkItem(ref, { views: 1 })) } };
}

const noSleep = () => Promise.resolve();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseVkWallRef", () => {
  it("extracts <owner>_<post> refs, including negative group owners", () => {
    expect(parseVkWallRef("https://vk.com/wall29642349_300")).toBe("29642349_300");
    expect(parseVkWallRef("https://vk.com/wall-1_2")).toBe("-1_2");
    expect(parseVkWallRef("http://vk.com/wall1_2")).toBe("1_2");
    expect(parseVkWallRef("https://www.vk.com/wall1_2")).toBe("1_2");
    expect(parseVkWallRef("https://m.vk.com/wall1_2?z=1")).toBe("1_2");
    expect(parseVkWallRef("https://vk.com/wall1_2/")).toBe("1_2");
  });

  it("returns null on non-wall urls and malformed refs", () => {
    expect(parseVkWallRef("https://vk.com/wall1")).toBeNull();
    expect(parseVkWallRef("https://vk.com/wall_2")).toBeNull();
    expect(parseVkWallRef("https://vk.com/wall1_2_3")).toBeNull();
    expect(parseVkWallRef("https://vk.com/wall1_2extra")).toBeNull();
    expect(parseVkWallRef("https://vk.com/photo1_2")).toBeNull();
    expect(parseVkWallRef("https://example.com/wall1_2")).toBeNull();
    expect(parseVkWallRef("not a url")).toBeNull();
    expect(parseVkWallRef("")).toBeNull();
  });
});

describe("VkCollector", () => {
  it("maps response.items counts onto metric outcomes", async () => {
    const mock = mockFetch((posts) => ({
      response: {
        items: posts.map((ref) => vkItem(ref, { views: 10, likes: 3, comments: 2 })),
      },
    }));
    const collector = new VkCollector({ token: "t", fetch: mock.fetch, sleep: noSleep });
    const outcomes = await collector.collect([makeItem()], ctx());

    expect(mock.calls).toEqual([["29642349_300"]]);
    expect(outcomes).toHaveLength(1);
    const out = outcomes[0];
    expect(out?.kind).toBe("metric");
    if (out?.kind === "metric") {
      expect(out.snapshot).toMatchObject({
        item_id: "item-1",
        platform: "vk",
        ts: "2026-04-01T12:00:00.000Z",
        views: 10,
        likes: 3,
        comments: 2,
      });
      expect(out.snapshot.raw).toMatchObject({ id: 300, owner_id: 29642349 });
    }
  });

  it("sends access_token, v and posts in the request body", async () => {
    let seen = "";
    const fetchImpl: FetchLike = async (_url, init) => {
      seen = String(init?.body ?? "");
      return new Response(JSON.stringify(okFor(["1_1"])));
    };
    const collector = new VkCollector({ token: "secret-token", fetch: fetchImpl });
    await collector.collect([makeItem({ published_urls: ["https://vk.com/wall1_1"] })], ctx());
    const params = new URLSearchParams(seen);
    expect(params.get("access_token")).toBe("secret-token");
    expect(params.get("v")).toBe("5.199");
    expect(params.get("posts")).toBe("1_1");
  });

  it("splits batches of more than 100 posts", async () => {
    const items = Array.from({ length: VK_BATCH_LIMIT + 1 }, (_, i) =>
      makeItem({ id: `it-${i}`, published_urls: [`https://vk.com/wall1_${i + 1}`] }),
    );
    const mock = mockFetch(okFor);
    const collector = new VkCollector({ token: "t", fetch: mock.fetch, sleep: noSleep });
    const outcomes = await collector.collect(items, ctx());

    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]).toHaveLength(VK_BATCH_LIMIT);
    expect(mock.calls[1]).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === "metric")).toHaveLength(VK_BATCH_LIMIT + 1);
  });

  it("retries VK error 9 with exponential backoff, then skips + warns when exhausted", async () => {
    const warnings: string[] = [];
    const delays: number[] = [];
    const mock = mockFetch(() => ({ error: { error_code: 9, error_msg: "Flood control" } }));
    const collector = new VkCollector({
      token: "t",
      fetch: mock.fetch,
      maxRetries: 3,
      baseDelayMs: 1000,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    const outcomes = await collector.collect([makeItem()], ctx(warnings));

    expect(mock.calls).toHaveLength(4); // initial + 3 retries
    expect(delays).toEqual([1000, 2000, 4000]);
    expect(outcomes).toEqual([
      {
        kind: "skip",
        item_id: "item-1",
        reason: "vk error 9: Flood control",
      },
    ]);
    expect(warnings.some((w) => w.includes("rate-limited"))).toBe(true);
  });

  it("recovers when an error-9 retry succeeds", async () => {
    let n = 0;
    const mock = mockFetch((posts) => {
      n += 1;
      return n === 1 ? { error: { error_code: 9, error_msg: "Flood control" } } : okFor(posts);
    });
    const collector = new VkCollector({ token: "t", fetch: mock.fetch, sleep: noSleep });
    const outcomes = await collector.collect([makeItem()], ctx());
    expect(mock.calls).toHaveLength(2);
    expect(outcomes[0]?.kind).toBe("metric");
  });

  it("marks auth errors (codes 5 and 17) as errored without retrying", async () => {
    for (const code of [5, 17]) {
      const mock = mockFetch(() => ({ error: { error_code: code, error_msg: "auth fail" } }));
      const collector = new VkCollector({ token: "t", fetch: mock.fetch, sleep: noSleep });
      const outcomes = await collector.collect([makeItem()], ctx());
      expect(mock.calls).toHaveLength(1); // no retries on auth
      expect(outcomes).toEqual([
        {
          kind: "error",
          item_id: "item-1",
          code: METRICS_AUTH,
          message: `vk error ${code}: auth fail`,
        },
      ]);
    }
  });

  it("skips items on other VK errors and keeps going", async () => {
    const mock = mockFetch(() => ({ error: { error_code: 30, error_msg: "profile deleted" } }));
    const collector = new VkCollector({ token: "t", fetch: mock.fetch, sleep: noSleep });
    const outcomes = await collector.collect([makeItem()], ctx());
    expect(outcomes).toEqual([
      { kind: "skip", item_id: "item-1", reason: "vk error 30: profile deleted" },
    ]);
  });

  it("reports fetch/HTTP failures as metrics_upstream errors", async () => {
    const boom: FetchLike = () => Promise.reject(new Error("socket hangup"));
    const collector = new VkCollector({ token: "t", fetch: boom, sleep: noSleep });
    const outcomes = await collector.collect([makeItem()], ctx());
    expect(outcomes).toEqual([
      {
        kind: "error",
        item_id: "item-1",
        code: "metrics_upstream",
        message: "post 29642349_300: fetch failed: socket hangup",
      },
    ]);

    const httpErr: FetchLike = () => Promise.resolve(new Response("nope", { status: 500 }));
    const c2 = new VkCollector({ token: "t", fetch: httpErr, sleep: noSleep });
    const o2 = await c2.collect([makeItem()], ctx());
    expect(o2[0]?.kind).toBe("error");
    if (o2[0]?.kind === "error") {
      expect(o2[0].code).toBe("metrics_upstream");
      expect(o2[0].message).toContain("HTTP 500");
    }
  });

  it("skips items whose published_urls carry no vk wall ref", async () => {
    const mock = mockFetch(okFor);
    const collector = new VkCollector({ token: "t", fetch: mock.fetch });
    const outcomes = await collector.collect(
      [
        makeItem({ id: "no-urls", published_urls: [] }),
        makeItem({ id: "other-host", published_urls: ["https://t.me/x/1"] }),
        makeItem({ id: "bad-vk", published_urls: ["https://vk.com/photo1_2"] }),
      ],
      ctx(),
    );
    expect(mock.calls).toHaveLength(0);
    expect(outcomes).toHaveLength(3);
    for (const out of outcomes) {
      expect(out.kind).toBe("skip");
      if (out.kind === "skip") {
        expect(out.reason).toContain("no parseable vk wall url");
      }
    }
  });

  it("uses the first wall ref and warns on extra refs", async () => {
    const warnings: string[] = [];
    const mock = mockFetch(okFor);
    const collector = new VkCollector({ token: "t", fetch: mock.fetch });
    const item = makeItem({
      published_urls: ["https://vk.com/wall1_1", "https://vk.com/wall1_2"],
    });
    const outcomes = await collector.collect([item], ctx(warnings));
    expect(mock.calls).toEqual([["1_1"]]);
    expect(outcomes[0]?.kind).toBe("metric");
    expect(warnings.some((w) => w.includes("extra wall ref"))).toBe(true);
  });

  it("dedupes a wall ref shared by several items into one request", async () => {
    const mock = mockFetch(okFor);
    const collector = new VkCollector({ token: "t", fetch: mock.fetch });
    const outcomes = await collector.collect([makeItem({ id: "a" }), makeItem({ id: "b" })], ctx());
    expect(mock.calls).toEqual([["29642349_300"]]);
    expect(outcomes.map((o) => o.item_id)).toEqual(["a", "b"]);
    expect(outcomes.every((o) => o.kind === "metric")).toBe(true);
  });

  it("skips a requested ref the API does not return", async () => {
    const mock = mockFetch(() => ({ response: { items: [] } }));
    const collector = new VkCollector({ token: "t", fetch: mock.fetch });
    const outcomes = await collector.collect([makeItem()], ctx());
    expect(outcomes).toEqual([
      {
        kind: "skip",
        item_id: "item-1",
        reason: "post 29642349_300: not returned by wall.getById (deleted/hidden?)",
      },
    ]);
  });

  it("fails collect() with metrics_auth when no token is configured", async () => {
    vi.stubEnv("VK_TOKEN", "");
    const mock = mockFetch(okFor);
    const collector = new VkCollector({ fetch: mock.fetch });
    await expect(collector.collect([makeItem()], ctx())).rejects.toMatchObject({
      code: METRICS_AUTH,
      retryable: false,
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("falls back to the VK_TOKEN env var when no option token is given", async () => {
    vi.stubEnv("VK_TOKEN", "env-token");
    let seen = "";
    const fetchImpl: FetchLike = async (_url, init) => {
      seen = String(init?.body ?? "");
      return new Response(JSON.stringify(okFor(["29642349_300"])));
    };
    const collector = new VkCollector({ fetch: fetchImpl });
    const outcomes: CollectOutcome[] = await collector.collect([makeItem()], ctx());
    expect(new URLSearchParams(seen).get("access_token")).toBe("env-token");
    expect(outcomes[0]?.kind).toBe("metric");
  });
});
