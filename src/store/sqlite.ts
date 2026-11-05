/**
 * SqliteStore - the better-sqlite3 implementation of StateStore
 * (roadmap item_04, contract src/store/contract.ts).
 *
 * Schema lives in src/migrations/ as numbered modules applied by
 * {@link SqliteStore.migrate} inside transactions; the applied version
 * is tracked via `PRAGMA user_version` and surfaced as
 * {@link SqliteStore.schemaVersion}.
 *
 * Behavioral notes:
 * - upsert deduplicates on (source_kind, external_id) via a UNIQUE
 *   index; a different item id claiming a held key throws Conflict.
 * - The regression guard recommended by the contract is enforced: an
 *   update whose `status` is not a legal move from the stored one under
 *   transitionStatus rules throws InvalidTransition and writes nothing.
 *   The ingester therefore MUST do fetch -> transitionStatus -> upsert.
 * - `raw` column: the store persists an optional `raw` field carried on
 *   the item (ingest-side extension, NOT part of the ContentItem
 *   contract - the upstream record, e.g. a publish_log line keeping its
 *   `maybe_live` flag). NULL when the item carries none; the payload is
 *   re-attached on reads so re-upserts keep it verbatim.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../migrations/index.js";
import {
  type ContentItem,
  type ContentStatus,
  type ContentTimestamps,
  InvalidTransition,
  type MetricSnapshot,
  type Platform,
  type ProfileReport,
  type Recommendation,
  type RecommendationStatus,
  transitionStatus,
} from "../model/contract.js";
import { Conflict, idempotencyKey, NotFound, SCHEMA_VERSION, type StateStore } from "./contract.js";

/** Upstream payload an ingester may attach to an item for the `raw` column. */
export interface WithRaw {
  raw?: unknown;
}

interface ItemRow {
  id: string;
  source_kind: string;
  external_id: string | null;
  dedupe_key: string;
  status: string;
  platform_refs: string;
  published_urls: string;
  objective: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  raw: string | null;
}

interface MetricRow {
  item_id: string;
  platform: string;
  ts: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  raw: string | null;
}

interface RecommendationRow {
  id: string;
  ts: string;
  topic: string;
  objective: string;
  platform: string;
  status: string;
}

interface ReportRow {
  id: string;
  ts: string;
  platform: string;
  findings: string;
}

/**
 * Recommendation lifecycle edges, mirroring the reference impl in
 * src/store/contract.test.ts: proposed -> sent -> accepted | dismissed;
 * accepted/dismissed are terminal-ish; same-status is a no-op.
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

export class SqliteStore implements StateStore {
  readonly db: Database.Database;

  /**
   * Open (creating if needed) the database at `dbPath`. The literal
   * ":memory:" selects an in-memory database. Parent directories of a
   * file path are created as needed. The store is NOT migrated here -
   * callers run {@link migrate} once at startup.
   */
  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("foreign_keys = ON");
  }

  /** Close the underlying database handle. */
  close(): void {
    this.db.close();
  }

  get schemaVersion(): number {
    const row = this.db.pragma("user_version", { simple: true }) as number;
    return row;
  }

  /**
   * Apply every pending migration inside one transaction each and bump
   * `PRAGMA user_version`. Idempotent on an up-to-date database.
   */
  migrate(): void {
    const current = this.schemaVersion;
    const pending = MIGRATIONS.filter((m) => m.version > current).sort(
      (a, b) => a.version - b.version,
    );
    for (const m of pending) {
      this.db.transaction(() => {
        m.up(this.db);
        this.db.pragma(`user_version = ${m.version}`);
      })();
    }
  }

  upsertContentItem(item: ContentItem): ContentItem {
    const { source_kind, external_id } = idempotencyKey(item);
    // external_id stores the item's OWN external id (NULL when absent
    // or blank - blank is not a dedupe key); dedupe_key stores the
    // resolved idempotency key (falling back to id) under the UNIQUE
    // constraint, exactly matching the reference MemoryStore semantics.
    const storedExternal =
      item.external_id === undefined || item.external_id.trim() === "" ? null : item.external_id;

    const holder = this.db
      .prepare("SELECT id FROM content_items WHERE source_kind = ? AND dedupe_key = ?")
      .get(source_kind, external_id) as { id: string } | undefined;
    if (holder !== undefined && holder.id !== item.id) {
      throw new Conflict(source_kind, external_id);
    }

    const existing = this.db.prepare("SELECT * FROM content_items WHERE id = ?").get(item.id) as
      | ItemRow
      | undefined;
    if (existing !== undefined && existing.status !== item.status) {
      // Regression guard: the incoming status must be a legal move from
      // the stored one. transitionStatus is invoked for the CHECK only;
      // the item is still persisted as given below.
      transitionStatus(rowToItem(existing), item.status);
    }

    const upstream = (item as WithRaw).raw;
    const rawJson = upstream === undefined ? null : JSON.stringify(upstream);
    this.db
      .prepare(
        `INSERT INTO content_items
           (id, source_kind, external_id, dedupe_key, status, platform_refs, published_urls,
            objective, created_at, updated_at, published_at, raw)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           source_kind = excluded.source_kind,
           external_id = excluded.external_id,
           dedupe_key = excluded.dedupe_key,
           status = excluded.status,
           platform_refs = excluded.platform_refs,
           published_urls = excluded.published_urls,
           objective = excluded.objective,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           published_at = excluded.published_at,
           raw = excluded.raw`,
      )
      .run(
        item.id,
        source_kind,
        storedExternal,
        external_id,
        item.status,
        JSON.stringify(item.platform_refs),
        JSON.stringify(item.published_urls),
        item.objective,
        item.timestamps.created_at,
        item.timestamps.updated_at,
        item.timestamps.published_at ?? null,
        rawJson,
      );
    return item;
  }

  getByStatus(status: ContentStatus): ContentItem[] {
    const rows = this.db
      .prepare("SELECT * FROM content_items WHERE status = ?")
      .all(status) as ItemRow[];
    return rows.map(rowToItem);
  }

  getById(id: string): ContentItem {
    const row = this.db.prepare("SELECT * FROM content_items WHERE id = ?").get(id) as
      | ItemRow
      | undefined;
    if (row === undefined) {
      throw new NotFound("ContentItem", id);
    }
    return rowToItem(row);
  }

  recordMetric(snap: MetricSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO metrics (item_id, platform, ts, views, likes, comments, raw)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snap.item_id,
        snap.platform,
        snap.ts,
        snap.views ?? null,
        snap.likes ?? null,
        snap.comments ?? null,
        snap.raw === undefined ? null : JSON.stringify(snap.raw),
      );
  }

  metricsFor(itemId: string, since?: string): MetricSnapshot[] {
    const rows = (
      since === undefined
        ? this.db
            .prepare("SELECT * FROM metrics WHERE item_id = ? ORDER BY ts ASC, id ASC")
            .all(itemId)
        : this.db
            .prepare("SELECT * FROM metrics WHERE item_id = ? AND ts >= ? ORDER BY ts ASC, id ASC")
            .all(itemId, since)
    ) as MetricRow[];
    return rows.map(rowToMetric);
  }

  appendRecommendation(rec: Recommendation): void {
    const existing = this.db.prepare("SELECT * FROM recommendations WHERE id = ?").get(rec.id) as
      | RecommendationRow
      | undefined;
    if (existing !== undefined) {
      // Re-append on an existing id is an update and must respect the
      // lifecycle (stale re-emit cannot regress accepted/dismissed).
      assertRecommendationEdge(existing.status as RecommendationStatus, rec.status);
    }
    this.db
      .prepare(
        `INSERT INTO recommendations (id, ts, topic, objective, platform, status)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           ts = excluded.ts,
           topic = excluded.topic,
           objective = excluded.objective,
           platform = excluded.platform,
           status = excluded.status`,
      )
      .run(rec.id, rec.ts, rec.topic, rec.objective, rec.platform, rec.status);
  }

  listRecommendations(status?: RecommendationStatus): Recommendation[] {
    const rows = (
      status === undefined
        ? this.db.prepare("SELECT * FROM recommendations ORDER BY ts ASC, id ASC").all()
        : this.db
            .prepare("SELECT * FROM recommendations WHERE status = ? ORDER BY ts ASC, id ASC")
            .all(status)
    ) as RecommendationRow[];
    return rows.map(rowToRecommendation);
  }

  updateRecommendationStatus(id: string, to: RecommendationStatus): Recommendation {
    const row = this.db.prepare("SELECT * FROM recommendations WHERE id = ?").get(id) as
      | RecommendationRow
      | undefined;
    if (row === undefined) {
      throw new NotFound("Recommendation", id);
    }
    const rec = rowToRecommendation(row);
    if (rec.status === to) {
      return rec;
    }
    assertRecommendationEdge(rec.status, to);
    const next = { ...rec, status: to };
    this.db.prepare("UPDATE recommendations SET status = ? WHERE id = ?").run(to, id);
    return next;
  }

  upsertProfileReport(report: ProfileReport): ProfileReport {
    this.db
      .prepare(
        `INSERT INTO profile_reports (id, ts, platform, findings)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           ts = excluded.ts,
           platform = excluded.platform,
           findings = excluded.findings`,
      )
      .run(report.id, report.ts, report.platform, JSON.stringify(report.findings));
    return report;
  }

  latestReport(platform: Platform): ProfileReport | null {
    const row = this.db
      .prepare("SELECT * FROM profile_reports WHERE platform = ? ORDER BY ts DESC, id DESC LIMIT 1")
      .get(platform) as ReportRow | undefined;
    return row === undefined ? null : rowToReport(row);
  }

  pendingAudit(): ContentItem[] {
    return this.getByStatus("published");
  }
}

function rowToItem(row: ItemRow): ContentItem {
  const timestamps: ContentTimestamps = {
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.published_at !== null) {
    timestamps.published_at = row.published_at;
  }
  const item: ContentItem & WithRaw = {
    id: row.id,
    source_kind: row.source_kind,
    status: row.status as ContentStatus,
    platform_refs: JSON.parse(row.platform_refs) as Platform[],
    published_urls: JSON.parse(row.published_urls) as string[],
    objective: row.objective as ContentItem["objective"],
    timestamps,
  };
  if (row.external_id !== null) {
    item.external_id = row.external_id;
  }
  if (row.raw !== null) {
    item.raw = JSON.parse(row.raw);
  }
  return item;
}

function rowToMetric(row: MetricRow): MetricSnapshot {
  const snap: MetricSnapshot = {
    item_id: row.item_id,
    platform: row.platform as Platform,
    ts: row.ts,
  };
  if (row.views !== null) {
    snap.views = row.views;
  }
  if (row.likes !== null) {
    snap.likes = row.likes;
  }
  if (row.comments !== null) {
    snap.comments = row.comments;
  }
  if (row.raw !== null) {
    snap.raw = JSON.parse(row.raw);
  }
  return snap;
}

function rowToRecommendation(row: RecommendationRow): Recommendation {
  return {
    id: row.id,
    ts: row.ts,
    topic: row.topic,
    objective: row.objective as Recommendation["objective"],
    platform: row.platform as Platform,
    status: row.status as RecommendationStatus,
  };
}

function rowToReport(row: ReportRow): ProfileReport {
  return {
    id: row.id,
    ts: row.ts,
    platform: row.platform as Platform,
    findings: JSON.parse(row.findings) as string[],
  };
}

export { SCHEMA_VERSION };
