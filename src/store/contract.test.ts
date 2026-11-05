import { describe, expect, it } from "vitest";
import {
  type ContentItem,
  type ContentStatus,
  InvalidTransition,
  type MetricSnapshot,
  type Platform,
  type ProfileReport,
  type Recommendation,
  type RecommendationStatus,
  transitionStatus,
} from "../model/contract.js";
import { Conflict, idempotencyKey, NotFound, SCHEMA_VERSION, type StateStore } from "./contract.js";

/**
 * Recommendation lifecycle edge-check shared by appendRecommendation
 * (re-append = update) and updateRecommendationStatus:
 * proposed -> sent -> accepted | dismissed; accepted/dismissed are
 * terminal-ish (no outbound edges); same-status is a no-op; anything
 * else throws InvalidTransition.
 */
function assertRecommendationEdge(from: RecommendationStatus, to: RecommendationStatus): void {
  if (from === to) {
    return;
  }
  const legal =
    (from === "proposed" && to === "sent") ||
    (from === "sent" && (to === "accepted" || to === "dismissed"));
  if (!legal) {
    throw new InvalidTransition(from, to);
  }
}

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
  private recommendations = new Map<string, Recommendation>(); // id -> recommendation
  private reports = new Map<string, ProfileReport>(); // id -> report
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
    const existing = this.items.get(item.id);
    if (existing !== undefined && existing.status !== item.status) {
      // Recommended regression guard: the incoming status must be a
      // legal move from the stored one under transitionStatus rules, so
      // a stale upstream snapshot (e.g. published -> draft) cannot
      // regress the row. The store still persists `item` as given -
      // the guard only rejects the write.
      transitionStatus(existing, item.status);
    }
    // Free stale idempotency keys of this item (e.g. external_id
    // changed between upserts); a SQL UNIQUE index on the columns
    // moves with the row.
    for (const [k, v] of this.keyToId) {
      if (v === item.id && k !== key) {
        this.keyToId.delete(k);
      }
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
    const existing = this.recommendations.get(rec.id);
    if (existing !== undefined) {
      // Re-append on an existing id is an update and must respect the
      // lifecycle: a stale re-emit cannot regress accepted/dismissed
      // back to proposed (same stale-snapshot class as the upsert guard).
      assertRecommendationEdge(existing.status, rec.status);
    }
    this.recommendations.set(rec.id, rec);
  }

  listRecommendations(status?: RecommendationStatus): Recommendation[] {
    return [...this.recommendations.values()]
      .filter((r) => status === undefined || r.status === status)
      .sort((a, b) => a.ts.localeCompare(b.ts));
  }

  updateRecommendationStatus(id: string, to: RecommendationStatus): Recommendation {
    const rec = this.recommendations.get(id);
    if (!rec) {
      throw new NotFound("Recommendation", id);
    }
    if (rec.status === to) {
      return rec;
    }
    assertRecommendationEdge(rec.status, to);
    const next = { ...rec, status: to };
    this.recommendations.set(id, next);
    return next;
  }

  upsertProfileReport(report: ProfileReport): ProfileReport {
    this.reports.set(report.id, report);
    return report;
  }

  latestReport(platform: Platform): ProfileReport | null {
    let best: ProfileReport | null = null;
    for (const r of this.reports.values()) {
      if (r.platform === platform && (best === null || r.ts > best.ts)) {
        best = r;
      }
    }
    return best;
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

  it("treats an empty/whitespace external_id as absent (falls back to id)", () => {
    const store = new MemoryStore();
    store.upsertContentItem(makeItem({ id: "a", external_id: "" }));
    store.upsertContentItem(makeItem({ id: "b", external_id: "   " }));
    // blank external ids are not dedupe keys, so no spurious Conflict
    expect(store.rowCount()).toBe(2);
    expect(idempotencyKey(makeItem({ id: "c", external_id: "  " })).external_id).toBe("c");
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

  it("metricsFor ordering is chronological on normalized UTC timestamps", () => {
    const store = new MemoryStore();
    // Instants authored in different offsets, normalized to the required
    // `YYYY-MM-DDTHH:mm:ss.sssZ` form at write time (contract requirement:
    // callers normalize, the store compares lexicographically).
    const raws = [
      "2026-03-01T12:00:00+03:00", // == 2026-03-01T09:00:00.000Z
      "2026-03-01T10:00:00.000Z",
      "2026-03-01T08:30:00.000Z",
    ];
    for (const raw of raws) {
      store.recordMetric({ item_id: "item-1", platform: "vk", ts: new Date(raw).toISOString() });
    }

    const ts = store.metricsFor("item-1").map((s) => s.ts);
    expect(ts).toEqual([
      "2026-03-01T08:30:00.000Z",
      "2026-03-01T09:00:00.000Z",
      "2026-03-01T10:00:00.000Z",
    ]);
    // every stored ts is already in normalized form (re-normalizing is a no-op)
    for (const s of store.metricsFor("item-1")) {
      expect(s.ts).toBe(new Date(s.ts).toISOString());
    }
  });

  it("rejects a re-ingest that regresses status (stale published -> draft snapshot)", () => {
    const store = new MemoryStore();
    const published = makeItem({
      status: "published",
      timestamps: {
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
        published_at: "2026-01-02T00:00:00.000Z",
      },
    });
    store.upsertContentItem(published);

    expect(() => store.upsertContentItem(makeItem({ status: "draft" }))).toThrow(InvalidTransition);
    expect(store.getById("item-1").status).toBe("published");
    expect(store.getById("item-1").timestamps.published_at).toBe("2026-01-02T00:00:00.000Z");
  });

  it("upsert guard still allows legal moves: forward, draft -> brief, terminalizing", () => {
    const store = new MemoryStore();
    store.upsertContentItem(makeItem({ id: "fwd", status: "draft" }));
    store.upsertContentItem(makeItem({ id: "fwd", status: "published" }));
    expect(store.getById("fwd").status).toBe("published");

    store.upsertContentItem(makeItem({ id: "edit", status: "draft" }));
    store.upsertContentItem(makeItem({ id: "edit", status: "brief" })); // documented edit edge
    expect(store.getById("edit").status).toBe("brief");

    store.upsertContentItem(makeItem({ id: "dead", status: "queued" }));
    store.upsertContentItem(makeItem({ id: "dead", status: "failed" }));
    expect(store.getById("dead").status).toBe("failed");
  });

  it("rejects a re-ingest that moves out of a terminal status", () => {
    const store = new MemoryStore();
    store.upsertContentItem(makeItem({ status: "rejected" }));
    expect(() => store.upsertContentItem(makeItem({ status: "queued" }))).toThrow(
      InvalidTransition,
    );
  });

  it("frees the old idempotency key when external_id changes between upserts", () => {
    const store = new MemoryStore();
    store.upsertContentItem(makeItem({ id: "a", external_id: "ext-1" }));
    store.upsertContentItem(makeItem({ id: "a", external_id: "ext-2" }));
    // the stale ("n8n", "ext-1") key is released, so another item may claim it
    store.upsertContentItem(makeItem({ id: "b", external_id: "ext-1" }));
    expect(store.getById("b").external_id).toBe("ext-1");
    expect(store.rowCount()).toBe(2);
  });

  describe("recommendation lifecycle", () => {
    const rec = (
      id: string,
      status: RecommendationStatus,
      ts = "2026-01-01T00:00:00.000Z",
    ): Recommendation => ({
      id,
      ts,
      topic: `topic-${id}`,
      objective: "authority",
      platform: "vk",
      status,
    });

    it("lists appended recommendations ascending by ts, optionally filtered by status", () => {
      const store = new MemoryStore();
      store.appendRecommendation(rec("r2", "proposed", "2026-01-02T00:00:00.000Z"));
      store.appendRecommendation(rec("r1", "proposed", "2026-01-01T00:00:00.000Z"));
      store.updateRecommendationStatus("r2", "sent");

      expect(store.listRecommendations().map((r) => r.id)).toEqual(["r1", "r2"]);
      expect(store.listRecommendations("sent").map((r) => r.id)).toEqual(["r2"]);
      expect(store.listRecommendations("dismissed")).toEqual([]);
    });

    it("walks proposed -> sent -> accepted, returning the updated record", () => {
      const store = new MemoryStore();
      store.appendRecommendation(rec("r1", "proposed"));

      expect(store.updateRecommendationStatus("r1", "sent").status).toBe("sent");
      const accepted = store.updateRecommendationStatus("r1", "accepted");
      expect(accepted.status).toBe("accepted");
      expect(store.listRecommendations("accepted")).toEqual([accepted]);
    });

    it("allows sent -> dismissed", () => {
      const store = new MemoryStore();
      store.appendRecommendation(rec("r1", "proposed"));
      store.updateRecommendationStatus("r1", "sent");
      expect(store.updateRecommendationStatus("r1", "dismissed").status).toBe("dismissed");
    });

    it("rejects illegal moves: skip-edge and any move out of accepted/dismissed", () => {
      const store = new MemoryStore();
      store.appendRecommendation(rec("r1", "proposed"));
      store.appendRecommendation(rec("r2", "proposed"));
      store.appendRecommendation(rec("r3", "proposed"));

      expect(() => store.updateRecommendationStatus("r1", "accepted")).toThrow(InvalidTransition);

      store.updateRecommendationStatus("r2", "sent");
      store.updateRecommendationStatus("r2", "accepted");
      expect(() => store.updateRecommendationStatus("r2", "dismissed")).toThrow(InvalidTransition);
      expect(() => store.updateRecommendationStatus("r2", "sent")).toThrow(InvalidTransition);

      store.updateRecommendationStatus("r3", "sent");
      store.updateRecommendationStatus("r3", "dismissed");
      expect(() => store.updateRecommendationStatus("r3", "accepted")).toThrow(InvalidTransition);
    });

    it("treats a same-status write as an idempotent no-op", () => {
      const store = new MemoryStore();
      const r = rec("r1", "proposed");
      store.appendRecommendation(r);
      expect(store.updateRecommendationStatus("r1", "proposed")).toBe(r);
    });

    it("rejects a re-append that regresses the recommendation lifecycle", () => {
      const store = new MemoryStore();
      store.appendRecommendation(rec("r1", "proposed"));
      store.updateRecommendationStatus("r1", "sent");
      store.updateRecommendationStatus("r1", "accepted");

      // An emitter reusing a stable id must not regress accepted/dismissed
      // back to proposed - same stale-snapshot class as the upsert guard.
      expect(() => store.appendRecommendation(rec("r1", "proposed"))).toThrow(InvalidTransition);
      expect(() => store.appendRecommendation(rec("r1", "dismissed"))).toThrow(InvalidTransition);
      expect(store.listRecommendations("accepted")).toHaveLength(1);
    });

    it("allows a re-append with a legal forward move or identical status", () => {
      const store = new MemoryStore();
      store.appendRecommendation(rec("r1", "proposed"));

      store.appendRecommendation(rec("r1", "sent")); // proposed -> sent is a legal edge
      expect(store.listRecommendations("sent")).toHaveLength(1);

      const revised = { ...rec("r1", "sent"), topic: "revised" };
      store.appendRecommendation(revised); // same-status edge: no-op, record replaced
      expect(store.listRecommendations("sent")).toEqual([revised]);
    });

    it("throws NotFound when updating a missing recommendation", () => {
      const store = new MemoryStore();
      expect(() => store.updateRecommendationStatus("nope", "sent")).toThrow(NotFound);
      try {
        store.updateRecommendationStatus("nope", "sent");
        expect.unreachable();
      } catch (e) {
        expect((e as NotFound).entity).toBe("Recommendation");
      }
    });
  });

  describe("profile reports", () => {
    const report = (id: string, platform: Platform, ts: string): ProfileReport => ({
      id,
      ts,
      platform,
      findings: [`finding-${id}`],
    });

    it("latestReport returns the max-ts report per platform, null when none", () => {
      const store = new MemoryStore();
      expect(store.latestReport("vk")).toBeNull();

      store.upsertProfileReport(report("r1", "vk", "2026-01-10T00:00:00.000Z"));
      store.upsertProfileReport(report("r2", "vk", "2026-01-05T00:00:00.000Z"));
      store.upsertProfileReport(report("r3", "linkedin", "2026-01-20T00:00:00.000Z"));

      expect(store.latestReport("vk")?.id).toBe("r1");
      expect(store.latestReport("linkedin")?.id).toBe("r3");
      expect(store.latestReport("youtube")).toBeNull();
    });

    it("upsertProfileReport replaces a report with the same id", () => {
      const store = new MemoryStore();
      store.upsertProfileReport(report("r1", "vk", "2026-01-10T00:00:00.000Z"));
      const updated = { ...report("r1", "vk", "2026-01-10T00:00:00.000Z"), findings: ["new"] };
      expect(store.upsertProfileReport(updated)).toBe(updated);
      expect(store.latestReport("vk")?.findings).toEqual(["new"]);
    });
  });

  it("pendingAudit returns published items awaiting measurement", () => {
    const store = new MemoryStore();
    store.upsertContentItem(makeItem({ id: "d1", status: "draft" }));
    store.upsertContentItem(makeItem({ id: "p1", status: "published" }));
    store.upsertContentItem(makeItem({ id: "m1", status: "measured" }));

    expect(store.pendingAudit().map((i) => i.id)).toEqual(["p1"]);
  });
});
