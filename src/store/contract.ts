/**
 * Storage contract (roadmap item_02).
 *
 * Interface only - no implementation in this file. The concrete
 * SqliteStore (better-sqlite3, migrations under src/migrations/) lands
 * in item_04 and must satisfy this contract.
 */

import type {
  ContentItem,
  ContentStatus,
  MetricSnapshot,
  Platform,
  ProfileReport,
  Recommendation,
  RecommendationStatus,
} from "../model/contract.js";

/**
 * Schema version this contract expects. SqliteStore creates/updates the
 * `schema_version` row and migrates the database up to this number on
 * startup via {@link StateStore.migrate}.
 */
export const SCHEMA_VERSION = 1;

/** Thrown when a lookup addresses an entity that does not exist:
 * {@link StateStore.getById} on a missing ContentItem, or
 * {@link StateStore.updateRecommendationStatus} on a missing
 * Recommendation. */
export class NotFound extends Error {
  readonly code = "NOT_FOUND" as const;

  constructor(
    readonly entity: string,
    readonly id: string,
  ) {
    super(`${entity} not found: ${id}`);
    this.name = "NotFound";
  }
}

/**
 * Thrown on an idempotency violation: the caller upserts an item whose
 * (source_kind, external_id) key is already held by a DIFFERENT item id.
 * Same key + same id is an update (idempotent re-ingest); same key +
 * different id is a Conflict.
 */
export class Conflict extends Error {
  readonly code = "CONFLICT" as const;

  constructor(
    readonly source_kind: string,
    readonly external_id: string,
  ) {
    super(`idempotency conflict on (${source_kind}, ${external_id})`);
    this.name = "Conflict";
  }
}

/**
 * Derives the idempotency key of a content item: the pair
 * (source_kind, external_id) where external_id defaults to item.id when
 * the item does not carry one. Implementations of
 * {@link StateStore.upsertContentItem} must key deduplication on this.
 */
export function idempotencyKey(item: ContentItem): {
  source_kind: string;
  external_id: string;
} {
  return { source_kind: item.source_kind, external_id: item.external_id ?? item.id };
}

/**
 * Persistence boundary of the service. All methods are synchronous:
 * the reference implementation is better-sqlite3, which is sync, and
 * callers (ingester, collectors, digest) are designed around that.
 */
export interface StateStore {
  /**
   * Schema version of the underlying storage AFTER {@link migrate}.
   * A freshly constructed store may report a lower version; after a
   * successful migrate() it must equal {@link SCHEMA_VERSION}.
   */
  readonly schemaVersion: number;

  /**
   * Apply pending schema migrations. Called once at service startup,
   * before the store serves any traffic. Idempotent: on an up-to-date
   * store it is a no-op. On failure it throws and the service must not
   * start serving against a partially migrated schema.
   */
  migrate(): void;

  /**
   * Idempotent upsert of a content item, keyed by
   * (source_kind, external_id) - see {@link idempotencyKey}:
   *
   * - No row with that key: insert.
   * - Row exists and belongs to the same item id: full update. This is
   *   the re-ingest path - running the ingester twice over the same
   *   upstream file must update in place, never duplicate.
   * - Row exists but belongs to a different item id: throw
   *   {@link Conflict} (two internal items claiming one upstream entity).
   *
   * The item is stored AS GIVEN: the store does NOT run
   * transitionStatus on it. To keep `status` monotonic, callers MUST
   * follow fetch -> transitionStatus -> upsert instead of upserting a
   * raw upstream snapshot; a stale snapshot would otherwise regress
   * `status` (e.g. published -> draft) and clobber `published_at`.
   * Consequently an implementation MAY reject a write whose `status` is
   * not a legal move from the stored one under transitionStatus rules
   * (recommended guard; the MemoryStore reference impl in
   * contract.test.ts demonstrates it).
   *
   * @returns the stored item.
   */
  upsertContentItem(item: ContentItem): ContentItem;

  /** All items currently in `status`. Ordering is unspecified. */
  getByStatus(status: ContentStatus): ContentItem[];

  /**
   * Fetch one item by internal id.
   * @throws {NotFound} when no item with this id exists.
   */
  getById(id: string): ContentItem;

  /**
   * Append an immutable metric snapshot. `snap.ts` must be a normalized
   * UTC ISO-8601 timestamp (`YYYY-MM-DDTHH:mm:ss.sssZ`) - see
   * ContentTimestamps in the model contract.
   */
  recordMetric(snap: MetricSnapshot): void;

  /**
   * Snapshots recorded for an item, ascending by `ts`. When `since` is
   * given, only snapshots with ts >= since are returned. Both `since`
   * and the stored `ts` values MUST be normalized UTC ISO-8601
   * (`YYYY-MM-DDTHH:mm:ss.sssZ`): the comparison is lexicographic, so an
   * offset form like `+03:00` would filter and sort incorrectly.
   * Unknown item ids yield an empty list, not an error.
   */
  metricsFor(itemId: string, since?: string): MetricSnapshot[];

  /**
   * Persist a recommendation emitted by the digest/strategist loop,
   * keyed by `rec.id`. A repeat append with an existing id replaces the
   * stored record; status moves afterwards belong to
   * {@link updateRecommendationStatus}. `rec.ts` must be a normalized
   * UTC ISO-8601 timestamp.
   */
  appendRecommendation(rec: Recommendation): void;

  /**
   * Stored recommendations, optionally restricted to one status.
   * Ordering: ascending `ts` (normalized UTC ISO-8601).
   */
  listRecommendations(status?: RecommendationStatus): Recommendation[];

  /**
   * Move a recommendation along its lifecycle (see RecommendationStatus
   * in the model contract):
   *
   *   proposed -> sent -> accepted | dismissed
   *
   * Only these three forward edges are legal; "accepted" and
   * "dismissed" are terminal-ish - no transition may leave them. A
   * same-status write is an idempotent no-op returning the stored
   * record unchanged.
   *
   * @throws {NotFound} when no recommendation with this id exists.
   * @throws {InvalidTransition} on a move the lifecycle forbids.
   * @returns the updated recommendation.
   */
  updateRecommendationStatus(id: string, to: RecommendationStatus): Recommendation;

  /**
   * Store a profile audit report, keyed by `report.id`: an existing
   * report with the same id is replaced. `report.ts` must be a
   * normalized UTC ISO-8601 timestamp.
   * @returns the stored report.
   */
  upsertProfileReport(report: ProfileReport): ProfileReport;

  /**
   * The most recent report stored for `platform` (max `ts`, relying on
   * lexicographically comparable normalized timestamps), or `null` when
   * none exists.
   */
  latestReport(platform: Platform): ProfileReport | null;

  /**
   * Items pending audit: those in "published" status, i.e. live upstream
   * but not yet measured. The metrics/audit loop moves them to
   * "measured" via transitionStatus once metrics have been collected.
   */
  pendingAudit(): ContentItem[];
}
