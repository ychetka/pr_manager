import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IngestedContentItem } from "../ingest/parsers.js";
import {
  type ContentItem,
  InvalidTransition,
  type MetricSnapshot,
  type Platform,
  type ProfileReport,
  type Recommendation,
  type RecommendationStatus,
} from "../model/contract.js";
import { Conflict, idempotencyKey, NotFound, SCHEMA_VERSION } from "./contract.js";
import { SqliteStore } from "./sqlite.js";

const tmpDirs: string[] = [];
const stores: SqliteStore[] = [];

function memStore(): SqliteStore {
  const s = new SqliteStore(":memory:");
  s.migrate();
  stores.push(s);
  return s;
}

async function tmpStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pr-manager-sqlite-"));
  tmpDirs.push(dir);
  return join(dir, "state.db");
}

afterEach(async () => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d !== undefined) {
      await rm(d, { recursive: true, force: true });
    }
  }
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

describe("SqliteStore - schema migrations", () => {
  it("reports version 0 before migrate, SCHEMA_VERSION after, idempotent re-migrate", () => {
    const s = new SqliteStore(":memory:");
    stores.push(s);
    expect(s.schemaVersion).toBe(0);
    s.migrate();
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    s.migrate();
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("persists data and schema across reopens on a file db", async () => {
    const path = await tmpStorePath();
    const s1 = new SqliteStore(path);
    s1.migrate();
    s1.upsertContentItem(makeItem({ id: "persisted" }));
    s1.close();

    const s2 = new SqliteStore(path);
    stores.push(s2);
    expect(s2.schemaVersion).toBe(SCHEMA_VERSION); // migrations already applied
    s2.migrate(); // no-op
    expect(s2.getById("persisted").status).toBe("draft");
  });

  it("refuses to migrate a database newer than the code (user_version > max migration)", () => {
    const s = new SqliteStore(":memory:");
    stores.push(s);
    s.migrate();
    s.db.pragma("user_version = 999");
    expect(() => s.migrate()).toThrow(/newer than this code/);
  });

  it("creates the db file in a missing parent directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr-manager-sqlite-"));
    tmpDirs.push(dir);
    const nested = join(dir, "a", "b", "state.db");
    const s = new SqliteStore(nested);
    stores.push(s);
    s.migrate();
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
  });
});

describe("SqliteStore - content items", () => {
  it("upserts a new item and reads it back by id and status", () => {
    const store = memStore();
    const item = makeItem();
    expect(store.upsertContentItem(item)).toBe(item);
    expect(store.getById("item-1")).toEqual(item);
    expect(store.getByStatus("draft")).toEqual([item]);
    expect(store.getByStatus("published")).toEqual([]);
  });

  it("re-upserting the same (source_kind, external_id) updates, not duplicates", () => {
    const store = memStore();
    store.upsertContentItem(makeItem({ status: "draft" }));
    const updated = makeItem({ status: "queued", published_urls: ["https://vk.com/wall1_2"] });
    store.upsertContentItem(updated);

    expect(store.getById("item-1")).toEqual(updated);
    expect(store.getByStatus("queued")).toHaveLength(1);
    expect(store.getByStatus("draft")).toHaveLength(0);
    const count = store.db.prepare("SELECT COUNT(*) AS n FROM content_items").get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });

  it("dedupes on external_id when it differs from id", () => {
    const store = memStore();
    store.upsertContentItem(makeItem({ id: "a", external_id: "ext-9" }));
    store.upsertContentItem(makeItem({ id: "a", external_id: "ext-9", status: "approved" }));
    expect(store.getById("a").status).toBe("approved");
  });

  it("treats an empty/whitespace external_id as absent (falls back to id)", () => {
    const store = memStore();
    store.upsertContentItem(makeItem({ id: "a", external_id: "" }));
    store.upsertContentItem(makeItem({ id: "b", external_id: "   " }));
    expect(store.getById("a").source_kind).toBe("n8n");
    expect(store.getById("b").source_kind).toBe("n8n");
    expect(idempotencyKey(makeItem({ id: "c", external_id: "  " })).external_id).toBe("c");
  });

  it("throws Conflict when a different id claims a taken (source_kind, external_id)", () => {
    const store = memStore();
    store.upsertContentItem(makeItem({ id: "a", external_id: "ext-9" }));
    expect(() => store.upsertContentItem(makeItem({ id: "b", external_id: "ext-9" }))).toThrow(
      Conflict,
    );
  });

  it("getById throws NotFound for a missing item", () => {
    const store = memStore();
    expect(() => store.getById("nope")).toThrow(NotFound);
    try {
      store.getById("nope");
      expect.unreachable();
    } catch (e) {
      expect((e as NotFound).code).toBe("NOT_FOUND");
      expect((e as NotFound).entity).toBe("ContentItem");
    }
  });

  it("rejects a re-ingest that regresses status (stale published -> draft snapshot)", () => {
    const store = memStore();
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
    const after = store.getById("item-1");
    expect(after.status).toBe("published");
    expect(after.timestamps.published_at).toBe("2026-01-02T00:00:00.000Z");
  });

  it("upsert guard still allows legal moves: forward, draft -> brief, terminalizing", () => {
    const store = memStore();
    store.upsertContentItem(makeItem({ id: "fwd", status: "draft" }));
    store.upsertContentItem(makeItem({ id: "fwd", status: "published" }));
    expect(store.getById("fwd").status).toBe("published");

    store.upsertContentItem(makeItem({ id: "edit", status: "draft" }));
    store.upsertContentItem(makeItem({ id: "edit", status: "brief" }));
    expect(store.getById("edit").status).toBe("brief");

    store.upsertContentItem(makeItem({ id: "dead", status: "queued" }));
    store.upsertContentItem(makeItem({ id: "dead", status: "failed" }));
    expect(store.getById("dead").status).toBe("failed");
  });

  it("rejects a re-ingest that moves out of a terminal status", () => {
    const store = memStore();
    store.upsertContentItem(makeItem({ status: "rejected" }));
    expect(() => store.upsertContentItem(makeItem({ status: "queued" }))).toThrow(
      InvalidTransition,
    );
  });

  it("frees the old idempotency key when external_id changes between upserts", () => {
    const store = memStore();
    store.upsertContentItem(makeItem({ id: "a", external_id: "ext-1" }));
    store.upsertContentItem(makeItem({ id: "a", external_id: "ext-2" }));
    // the stale ("n8n", "ext-1") key is released, so another item may claim it
    store.upsertContentItem(makeItem({ id: "b", external_id: "ext-1" }));
    expect(store.getById("b").external_id).toBe("ext-1");
  });

  it("stores and returns an attached upstream `raw` payload verbatim (ingest extension)", () => {
    const store = memStore();
    const rawText = '{"maybe_live":true,"error":"token expired"}';
    const item: IngestedContentItem = { ...makeItem({ id: "r1" }), raw: rawText };
    store.upsertContentItem(item);
    const read = store.getById("r1") as IngestedContentItem;
    expect(read.raw).toBe(rawText);
    expect(JSON.parse(read.raw as string).maybe_live).toBe(true);
  });
});

describe("SqliteStore - metrics", () => {
  it("metricsFor filters by since and returns ascending ts", () => {
    const store = memStore();
    const snaps: MetricSnapshot[] = [
      { item_id: "item-1", platform: "vk", ts: "2026-03-03T00:00:00.000Z", views: 30 },
      { item_id: "item-1", platform: "vk", ts: "2026-03-01T00:00:00.000Z", views: 10 },
      { item_id: "item-1", platform: "vk", ts: "2026-03-02T00:00:00.000Z", views: 20 },
    ];
    for (const s of snaps) store.recordMetric(s);

    expect(store.metricsFor("item-1").map((s) => s.views)).toEqual([10, 20, 30]);
    expect(store.metricsFor("item-1", "2026-03-02T00:00:00.000Z").map((s) => s.views)).toEqual([
      20, 30,
    ]);
    expect(store.metricsFor("unknown-item")).toEqual([]);
  });

  it("round-trips optional fields including raw", () => {
    const store = memStore();
    store.recordMetric({
      item_id: "i",
      platform: "vk",
      ts: "2026-01-01T00:00:00.000Z",
      views: 5,
      raw: { upstream: "payload" },
    });
    store.recordMetric({ item_id: "i", platform: "vk", ts: "2026-01-02T00:00:00.000Z" });
    const [withRaw, bare] = store.metricsFor("i");
    expect(withRaw).toEqual({
      item_id: "i",
      platform: "vk",
      ts: "2026-01-01T00:00:00.000Z",
      views: 5,
      raw: { upstream: "payload" },
    });
    expect(bare.views).toBeUndefined();
    expect(bare.raw).toBeUndefined();
  });
});

describe("SqliteStore - recommendation lifecycle", () => {
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
    const store = memStore();
    store.appendRecommendation(rec("r2", "proposed", "2026-01-02T00:00:00.000Z"));
    store.appendRecommendation(rec("r1", "proposed", "2026-01-01T00:00:00.000Z"));
    store.updateRecommendationStatus("r2", "sent");

    expect(store.listRecommendations().map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(store.listRecommendations("sent").map((r) => r.id)).toEqual(["r2"]);
    expect(store.listRecommendations("dismissed")).toEqual([]);
  });

  it("walks proposed -> sent -> accepted, returning the updated record", () => {
    const store = memStore();
    store.appendRecommendation(rec("r1", "proposed"));

    expect(store.updateRecommendationStatus("r1", "sent").status).toBe("sent");
    const accepted = store.updateRecommendationStatus("r1", "accepted");
    expect(accepted.status).toBe("accepted");
    expect(store.listRecommendations("accepted")).toEqual([accepted]);
  });

  it("allows sent -> dismissed", () => {
    const store = memStore();
    store.appendRecommendation(rec("r1", "proposed"));
    store.updateRecommendationStatus("r1", "sent");
    expect(store.updateRecommendationStatus("r1", "dismissed").status).toBe("dismissed");
  });

  it("rejects illegal moves: skip-edge and any move out of accepted/dismissed", () => {
    const store = memStore();
    store.appendRecommendation(rec("r1", "proposed"));
    store.appendRecommendation(rec("r2", "proposed"));

    expect(() => store.updateRecommendationStatus("r1", "accepted")).toThrow(InvalidTransition);

    store.updateRecommendationStatus("r2", "sent");
    store.updateRecommendationStatus("r2", "accepted");
    expect(() => store.updateRecommendationStatus("r2", "dismissed")).toThrow(InvalidTransition);
    expect(() => store.updateRecommendationStatus("r2", "sent")).toThrow(InvalidTransition);
  });

  it("treats a same-status write as an idempotent no-op", () => {
    const store = memStore();
    const r = rec("r1", "proposed");
    store.appendRecommendation(r);
    expect(store.updateRecommendationStatus("r1", "proposed")).toEqual(r);
  });

  it("rejects a re-append that regresses the recommendation lifecycle", () => {
    const store = memStore();
    store.appendRecommendation(rec("r1", "proposed"));
    store.updateRecommendationStatus("r1", "sent");
    store.updateRecommendationStatus("r1", "accepted");

    expect(() => store.appendRecommendation(rec("r1", "proposed"))).toThrow(InvalidTransition);
    expect(() => store.appendRecommendation(rec("r1", "dismissed"))).toThrow(InvalidTransition);
    expect(store.listRecommendations("accepted")).toHaveLength(1);
  });

  it("allows a re-append with a legal forward move or identical status", () => {
    const store = memStore();
    store.appendRecommendation(rec("r1", "proposed"));

    store.appendRecommendation(rec("r1", "sent"));
    expect(store.listRecommendations("sent")).toHaveLength(1);

    const revised = { ...rec("r1", "sent"), topic: "revised" };
    store.appendRecommendation(revised);
    expect(store.listRecommendations("sent")).toEqual([revised]);
  });

  it("throws NotFound when updating a missing recommendation", () => {
    const store = memStore();
    expect(() => store.updateRecommendationStatus("nope", "sent")).toThrow(NotFound);
  });
});

describe("SqliteStore - profile reports", () => {
  const report = (id: string, platform: Platform, ts: string): ProfileReport => ({
    id,
    ts,
    platform,
    findings: [`finding-${id}`],
  });

  it("latestReport returns the max-ts report per platform, null when none", () => {
    const store = memStore();
    expect(store.latestReport("vk")).toBeNull();

    store.upsertProfileReport(report("r1", "vk", "2026-01-10T00:00:00.000Z"));
    store.upsertProfileReport(report("r2", "vk", "2026-01-05T00:00:00.000Z"));
    store.upsertProfileReport(report("r3", "linkedin", "2026-01-20T00:00:00.000Z"));

    expect(store.latestReport("vk")?.id).toBe("r1");
    expect(store.latestReport("linkedin")?.id).toBe("r3");
    expect(store.latestReport("youtube")).toBeNull();
  });

  it("upsertProfileReport replaces a report with the same id", () => {
    const store = memStore();
    store.upsertProfileReport(report("r1", "vk", "2026-01-10T00:00:00.000Z"));
    const updated = { ...report("r1", "vk", "2026-01-10T00:00:00.000Z"), findings: ["new"] };
    expect(store.upsertProfileReport(updated)).toBe(updated);
    expect(store.latestReport("vk")?.findings).toEqual(["new"]);
  });
});

describe("SqliteStore - pendingAudit", () => {
  it("returns published items awaiting measurement", () => {
    const store = memStore();
    store.upsertContentItem(makeItem({ id: "d1", status: "draft" }));
    store.upsertContentItem(makeItem({ id: "p1", status: "published" }));
    store.upsertContentItem(makeItem({ id: "m1", status: "measured" }));

    expect(store.pendingAudit().map((i) => i.id)).toEqual(["p1"]);
  });
});
