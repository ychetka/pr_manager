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
  Recommendation,
} from "../model/contract.js";

/**
 * Schema version this contract expects. SqliteStore creates/updates the
 * `schema_version` row and migrates the database up to this number on
 * startup via {@link StateStore.migrate}.
 */
export const SCHEMA_VERSION = 1;

/** Thrown when a lookup addresses an entity that does not exist
 * (currently: {@link StateStore.getById} on a missing ContentItem). */
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

  /** Append an immutable metric snapshot. */
  recordMetric(snap: MetricSnapshot): void;

  /**
   * Snapshots recorded for an item, ascending by `ts`. When `since`
   * (ISO 8601) is given, only snapshots with ts >= since are returned.
   * Unknown item ids yield an empty list, not an error.
   */
  metricsFor(itemId: string, since?: string): MetricSnapshot[];

  /** Persist a recommendation emitted by the digest/strategist loop. */
  appendRecommendation(rec: Recommendation): void;

  /**
   * Items pending audit: those in "published" status, i.e. live upstream
   * but not yet measured. The metrics/audit loop moves them to
   * "measured" via transitionStatus once metrics have been collected.
   */
  pendingAudit(): ContentItem[];
}
