import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../llm.js";
import type { ContentItem, MetricSnapshot, Recommendation } from "../model/contract.js";
import { SqliteStore } from "../store/sqlite.js";
import { runDigest, sendToPipeline } from "./digest.js";

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
    status: "draft",
    platform_refs: ["vk"],
    published_urls: [],
    objective: "proof",
    timestamps: { created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
    ...over,
  };
}

/** Seed the GWT store: 3 drafts + 1 published. */
function seedStore(): SqliteStore {
  const store = memStore();
  store.upsertContentItem(makeItem({ id: "d1" }));
  store.upsertContentItem(makeItem({ id: "d2", objective: "authority" }));
  store.upsertContentItem(makeItem({ id: "d3", platform_refs: ["vk", "linkedin"] }));
  store.upsertContentItem(
    makeItem({
      id: "p1",
      status: "published",
      published_urls: ["https://vk.com/wall29642349_300"],
      timestamps: {
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-04-01T00:00:00.000Z",
        published_at: "2026-04-01T00:00:00.000Z",
      },
    }),
  );
  const snap: MetricSnapshot = {
    item_id: "p1",
    platform: "vk",
    ts: "2026-04-01T12:00:00.000Z",
    views: 120,
    likes: 5,
    comments: 2,
  };
  store.recordMetric(snap);
  return store;
}

interface CapturedCall {
  url: string;
  body: Record<string, unknown>;
}

interface RoutedFetch {
  fetch: FetchLike;
  calls: CapturedCall[];
  forUrl(substr: string): CapturedCall[];
}

/**
 * One stub covering every upstream the digest touches: the URL routes
 * the request to a per-endpoint responder and every call is captured
 * (url + parsed JSON body) for assertions.
 */
function routedFetch(handlers: {
  llm?: (body: Record<string, unknown>) => Response | Promise<Response>;
  telegram?: (body: Record<string, unknown>) => Response | Promise<Response>;
  webhook?: (body: Record<string, unknown>) => Response | Promise<Response>;
}): RoutedFetch {
  const calls: CapturedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const u = String(url);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: u, body });
    const handler = u.includes("api.telegram.org")
      ? handlers.telegram
      : u.includes("content-gen")
        ? handlers.webhook
        : handlers.llm;
    if (handler === undefined) {
      throw new Error(`no stub for ${u}`);
    }
    return handler(body);
  };
  return {
    fetch: fetchImpl,
    calls,
    forUrl: (substr) => calls.filter((c) => c.url.includes(substr)),
  };
}

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const tgOk = (): Response => jsonRes({ ok: true, result: { message_id: 1 } });

const baseOpts = (rf: RoutedFetch) => ({
  llm: { gatewayUrl: "http://gw.test", fetch: rf.fetch },
  telegram: { token: "tok", chatId: "42", fetch: rf.fetch },
  now: () => FIXED_NOW,
});

describe("runDigest", () => {
  it("GWT-1: Given 3 drafts + 1 published, When digest, Then the text contains status counts", async () => {
    const store = seedStore();
    const rf = routedFetch({
      // Echo the strategist input back as the digest text: whatever the
      // summary said is what Telegram must carry.
      llm: (body) => jsonRes({ role: "strategist", model: "m", backend: "b", text: body.input }),
      telegram: () => tgOk(),
    });

    const result = await runDigest(store, baseOpts(rf));

    expect(result.sent).toBe(true);
    expect(result.llm_used).toBe(true);
    const [tgCall] = rf.forUrl("api.telegram.org");
    const text = String(tgCall?.body.text);
    expect(text).toContain("draft=3");
    expect(text).toContain("published=1");
    // The same counts reached the strategist as input.
    const [llmCall] = rf.forUrl("/run");
    expect(String(llmCall?.body.input)).toContain("draft=3");
    expect(llmCall?.body.role).toBe("strategist");
  });

  it("GWT-2: Given llm-gateway 500, When digest, Then a raw digest is still sent to Telegram", async () => {
    const store = seedStore();
    const logs: string[] = [];
    const rf = routedFetch({
      llm: () => jsonRes({ error: "boom" }, 500),
      telegram: () => tgOk(),
    });

    const result = await runDigest(store, { ...baseOpts(rf), log: (m) => logs.push(m) });

    expect(result.llm_used).toBe(false);
    expect(result.briefs).toBe(0);
    expect(result.sent).toBe(true);
    const [tgCall] = rf.forUrl("api.telegram.org");
    const text = String(tgCall?.body.text);
    expect(text).toContain("draft=3");
    expect(text).toContain("published=1");
    expect(logs.some((m) => m.includes("raw digest"))).toBe(true);
    expect(result.error).toContain("llm");
  });

  it("GWT-3: Given a Telegram timeout, When digest, Then the failure is logged and the tick survives", async () => {
    const store = seedStore();
    const logs: string[] = [];
    const rf = routedFetch({
      llm: (body) => jsonRes({ role: "strategist", model: "m", backend: "b", text: body.input }),
      telegram: () => Promise.reject(new Error("request timed out")),
    });

    const result = await runDigest(store, { ...baseOpts(rf), log: (m) => logs.push(m) });

    expect(result.sent).toBe(false);
    expect(result.error).toContain("telegram");
    expect(logs.some((m) => m.includes("timed out"))).toBe(true);
  });

  it("GWT-4: Given strategist JSON briefs, When digest, Then 2-3 briefs persist as proposed Recommendations", async () => {
    const store = seedStore();
    const rf = routedFetch({
      llm: () =>
        jsonRes({
          role: "strategist",
          model: "m",
          backend: "b",
          json: {
            digest: "Pipeline is draft-heavy; ship the VK proof post.",
            briefs: [
              { topic: "Post the metrics story", objective: "proof", platform: "vk" },
              { topic: "How the pipeline works", objective: "authority", platform: "linkedin" },
              { topic: "ignore me", objective: "nope", platform: "vk" },
            ],
          },
        }),
      telegram: () => tgOk(),
    });

    const result = await runDigest(store, baseOpts(rf));

    expect(result.llm_used).toBe(true);
    expect(result.briefs).toBe(2);
    expect(result.recommendations).toHaveLength(2);
    const recs = store.listRecommendations("proposed");
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({
      topic: "Post the metrics story",
      objective: "proof",
      platform: "vk",
    });
    // One inline button per persisted recommendation, callback routed by id.
    const [tgCall] = rf.forUrl("api.telegram.org");
    const markup = tgCall?.body.reply_markup as { inline_keyboard: { callback_data: string }[][] };
    expect(markup.inline_keyboard).toHaveLength(2);
    expect(markup.inline_keyboard[0]?.[0]?.callback_data).toBe(
      `pipeline:${result.recommendations[0]}`,
    );
  });

  it("GWT-5a: Given Send to Pipeline, When callback, Then the brief POSTs to webhook/content-gen and the rec moves to sent", async () => {
    const store = seedStore();
    const rec: Recommendation = {
      id: "rec-20260402T083000Z-1",
      ts: "2026-04-02T08:30:00.000Z",
      topic: "Post the metrics story",
      objective: "proof",
      platform: "vk",
      status: "proposed",
    };
    store.appendRecommendation(rec);
    const logs: string[] = [];
    const rf = routedFetch({ webhook: () => jsonRes({ ok: true }) });

    const result = await sendToPipeline(store, rec.id, {
      webhookBase: "http://n8n.test",
      fetch: rf.fetch,
      log: (m) => logs.push(m),
    });

    expect(result.ok).toBe(true);
    expect(store.listRecommendations("sent")[0]?.id).toBe(rec.id);
    const [call] = rf.forUrl("content-gen");
    expect(call?.url).toBe("http://n8n.test/webhook/content-gen");
    const context = String(call?.body.context);
    // shared_person brief gate: context >= 200 chars, >= 2 digit-bearing tokens.
    expect(context.length).toBeGreaterThanOrEqual(200);
    expect(context.split(/\s+/).filter((t) => /\d/.test(t)).length).toBeGreaterThanOrEqual(2);
    expect(context).toContain("Post the metrics story");
    expect(call?.body.scope).toBeDefined();
    expect(logs.some((m) => m.includes("delivered"))).toBe(true);
  });

  it("GWT-5b: Given a failing webhook, When Send to Pipeline, Then the rec stays proposed and the error returns", async () => {
    const store = seedStore();
    const rec: Recommendation = {
      id: "rec-20260402T083000Z-1",
      ts: "2026-04-02T08:30:00.000Z",
      topic: "Post the metrics story",
      objective: "proof",
      platform: "vk",
      status: "proposed",
    };
    store.appendRecommendation(rec);
    const logs: string[] = [];
    const rf = routedFetch({ webhook: () => jsonRes({ error: "gate closed" }, 502) });

    const result = await sendToPipeline(store, rec.id, {
      webhookBase: "http://n8n.test",
      fetch: rf.fetch,
      log: (m) => logs.push(m),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("502");
    expect(store.listRecommendations("proposed")[0]?.id).toBe(rec.id);
  });
});
