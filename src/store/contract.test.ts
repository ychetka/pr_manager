import { describe, expect, it } from "vitest";
import type {
  ContentItem,
  ContentStatus,
  MetricSnapshot,
  Recommendation,
} from "../model/contract.js";
import { Conflict, idempotencyKey, NotFound, SCHEMA_VERSION, type StateStore } from "./contract.js";

/**
 * Minimal Map-based reference implementation of StateStore. Its only
 * purpose is to prove the contract is implementable and to pin the
 * behavioral rules (idempotent upsert, NotFound, metrics window,
 * pendingAudit). The real SqliteStore lands in item_04.
 */
class MemoryStore implements StateStore {
  private items = new Map<string, ContentItem>(); // internal id -> item
  private keyToId = new Map<string, string>(); // JSON [source_kind, external_id] -> internal id
  private metrics = new Map<string, MetricSnapshot[]>();
  private recommendations: Recommendation[] = [];
  private version = 0;

  get schemaVersion(): number {
    return this.version;
  }

  migrate(): void {
    this.version = SCHEMA_VERSION;
  }

  upsertContentItem(item: ContentItem): ContentItem {
    const { source_kind, external_id } = idempotencyKey(item);
    const key = JSON.stringify([source_kind, external_id]);
    const existingId = this.keyToId.get(key);
    if (existingId !== undefined && existingId !== item.id) {
      throw new Conflict(source_kind, external_id);
    }
    this.keyToId.set(key, item.id);
    this.items.set(item.id, item);
    return item;
  }

  getByStatus(status: ContentStatus): ContentItem[] {
    return [...this.items.values()].filter((i) => i.status === status);
  }

  getById(id: string): ContentItem {
    const item = this.items.get(id);
    if (!item) {
      throw new NotFound("ContentItem", id);
    }
    return item;
  }

  recordMetric(snap: MetricSnapshot): void {
    const list = this.metrics.get(snap.item_id) ?? [];
    list.push(snap);
    this.metrics.set(snap.item_id, list);
  }

  metricsFor(itemId: string, since?: string): MetricSnapshot[] {
    return (this.metrics.get(itemId) ?? [])
      .filter((s) => since === undefined || s.ts >= since)
      .sort((a, b) => a.ts.localeCompare(b.ts));
  }

  appendRecommendation(rec: Recommendation): void {
    this.recommendations.push(rec);
  }

  pendingAudit(): ContentItem[] {
    return this.getByStatus("published");
  }

  /** Test helper: number of stored content rows (not part of the contract). */
  rowCount(): number {
    return this.items.size;
  }
}

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

describe("StateStore contract (MemoryStore reference impl)", () => {
  it("migrate() brings schemaVersion to SCHEMA_VERSION and is idempotent", () => {
    const store = new MemoryStore();
    expect(store.schemaVersion).toBe(0);
    store.migrate();
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    store.migrate();
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("upserts a new item and reads it back by id and status", () => {
    const store = new MemoryStore();
    const item = makeItem();
    expect(store.upsertContentItem(item)).toBe(item);
    expect(store.getById("item-1")).toBe(item);
    expect(store.getByStatus("draft")).toEqual([item]);
    expect(store.getByStatus("published")).toEqual([]);
  });

  it("re-upserting the same (source_kind, external_id) updates, not duplicates", () => {
    const store = new MemoryStore();
    store.upsertContentItem(makeItem({ status: "draft" }));
    const updated = makeItem({ status: "queued", published_urls: ["https://vk.com/wall1_2"] });
    store.upsertContentItem(updated);

    expect(store.getById("item-1")).toBe(updated);
    expect(store.getByStatus("queued")).toHaveLength(1);
    expect(store.getByStatus("draft")).toHaveLength(0);
    // still a single logical row keyed by (n8n, item-1)
    expect(store.rowCount()).toBe(1);
  });

  it("dedupes on external_id when it differs from id", () => {
    const store = new MemoryStore();
    store.upsertContentItem(makeItem({ id: "a", external_id: "ext-9" }));
    store.upsertContentItem(makeItem({ id: "a", external_id: "ext-9", status: "approved" }));
    expect(store.getById("a").status).toBe("approved");
  });

  it("throws Conflict when a different id claims a taken (source_kind, external_id)", () => {
    const store = new MemoryStore();
    store.upsertContentItem(makeItem({ id: "a", external_id: "ext-9" }));
    expect(() => store.upsertContentItem(makeItem({ id: "b", external_id: "ext-9" }))).toThrow(
      Conflict,
    );
  });

  it("getById throws NotFound for a missing item", () => {
    const store = new MemoryStore();
    expect(() => store.getById("nope")).toThrow(NotFound);
    try {
      store.getById("nope");
      expect.unreachable();
    } catch (e) {
      expect((e as NotFound).code).toBe("NOT_FOUND");
    }
  });

  it("metricsFor filters by since and returns ascending ts", () => {
    const store = new MemoryStore();
    const snaps: MetricSnapshot[] = [
      { item_id: "item-1", platform: "vk", ts: "2026-03-03T00:00:00.000Z", views: 30 },
      { item_id: "item-1", platform: "vk", ts: "2026-03-01T00:00:00.000Z", views: 10 },
      { item_id: "item-1", platform: "vk", ts: "2026-03-02T00:00:00.000Z", views: 20 },
    ];
    for (const s of snaps) store.recordMetric(s);

    const all = store.metricsFor("item-1");
    expect(all.map((s) => s.views)).toEqual([10, 20, 30]);

    const since = store.metricsFor("item-1", "2026-03-02T00:00:00.000Z");
    expect(since.map((s) => s.views)).toEqual([20, 30]);

    expect(store.metricsFor("unknown-item")).toEqual([]);
  });

  it("pendingAudit returns published items awaiting measurement", () => {
    const store = new MemoryStore();
    store.upsertContentItem(makeItem({ id: "d1", status: "draft" }));
    store.upsertContentItem(makeItem({ id: "p1", status: "published" }));
    store.upsertContentItem(makeItem({ id: "m1", status: "measured" }));

    expect(store.pendingAudit().map((i) => i.id)).toEqual(["p1"]);
  });
});
