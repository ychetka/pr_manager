/**
 * Domain model contract (roadmap item_02).
 *
 * Pure types plus the content-pipeline state machine. No I/O and no
 * storage here - the persistence side lives in src/store/contract.ts.
 */

/** Social platforms the pipeline understands. */
export type Platform = "vk" | "linkedin" | "facebook" | "instagram" | "youtube";

export const PLATFORMS: readonly Platform[] = [
  "vk",
  "linkedin",
  "facebook",
  "instagram",
  "youtube",
];

/** Content pillar a post serves, per the BrandCharter (brand.yaml). */
export type Objective = "authority" | "proof" | "community";

/**
 * Status of a content item.
 *
 * The first eight form the linear pipeline, in order:
 * idea > brief > draft > moderation > approved > queued > published > measured.
 *
 * "failed" and "rejected" are terminal: once an item reaches either of
 * them it never leaves (see {@link transitionStatus}).
 */
export type ContentStatus =
  | "idea"
  | "brief"
  | "draft"
  | "moderation"
  | "approved"
  | "queued"
  | "published"
  | "measured"
  | "failed"
  | "rejected";

/** Pipeline statuses only - everything that is not terminal. */
export type PipelineStatus = Exclude<ContentStatus, "failed" | "rejected">;

export const TERMINAL_STATUSES: readonly ContentStatus[] = ["failed", "rejected"];

export function isTerminal(status: ContentStatus): status is "failed" | "rejected" {
  return TERMINAL_STATUSES.includes(status);
}

/** Thrown when a platform string is not one of {@link PLATFORMS}. */
export class UnknownPlatform extends Error {
  readonly code = "UNKNOWN_PLATFORM" as const;

  constructor(readonly input: string) {
    super(`unknown platform: ${JSON.stringify(input)}`);
    this.name = "UnknownPlatform";
  }
}

/**
 * Thrown on a status move a state machine forbids: by
 * {@link transitionStatus} for content items, and by
 * StateStore.updateRecommendationStatus / a store-side upsert regression
 * guard for recommendations and content items (see src/store/contract.ts).
 */
export class InvalidTransition extends Error {
  readonly code = "INVALID_TRANSITION" as const;

  constructor(
    readonly from: ContentStatus | RecommendationStatus,
    readonly to: ContentStatus | RecommendationStatus,
  ) {
    super(`invalid transition: ${from} -> ${to}`);
    this.name = "InvalidTransition";
  }
}

/**
 * Parse a raw platform string (e.g. from an ingest payload) into a
 * {@link Platform}. Throws {@link UnknownPlatform} on anything else,
 * so "tiktok" fails loudly instead of silently entering the model.
 */
export function parsePlatform(s: string): Platform {
  if ((PLATFORMS as readonly string[]).includes(s)) {
    return s as Platform;
  }
  throw new UnknownPlatform(s);
}

/**
 * ISO 8601 timestamps on a content item.
 *
 * Normalization requirement - applies to EVERY timestamp the model or
 * store consumes (`ts`, `created_at`, `updated_at`, `published_at`):
 * values MUST be UTC in the exact form `YYYY-MM-DDTHH:mm:ss.sssZ`, i.e.
 * the output of `Date.prototype.toISOString()`. Store queries compare
 * these strings lexicographically (metricsFor ordering and `since`
 * filtering, latestReport max-ts selection), so offset forms like
 * `+03:00` would sort and filter incorrectly. Callers must normalize at
 * write time.
 *
 * `published_at` is set once an item reaches the "published" status via
 * {@link transitionStatus}.
 */
export interface ContentTimestamps {
  created_at: string;
  updated_at: string;
  published_at?: string;
}

export interface ContentItem {
  /** Internal id. Also the fallback of {@link external_id}. */
  id: string;
  /**
   * Origin subsystem of the record, e.g. "n8n" or "manual". Together
   * with {@link external_id} it forms the idempotency key used by
   * StateStore.upsertContentItem.
   */
  source_kind: string;
  /**
   * Id of the upstream entity this item mirrors. When absent, the store
   * treats `id` as the external id.
   */
  external_id?: string;
  status: ContentStatus;
  platform_refs: Platform[];
  published_urls: string[];
  objective: Objective;
  timestamps: ContentTimestamps;
}

/** One measurement of a published item on one platform. `ts` is a
 * normalized UTC ISO-8601 timestamp (see {@link ContentTimestamps}) -
 * metricsFor orders and filters on it lexicographically. `raw` keeps the
 * unmodified upstream payload for debugging and re-derivation. */
export interface MetricSnapshot {
  item_id: string;
  platform: Platform;
  /** Normalized UTC ISO-8601, `YYYY-MM-DDTHH:mm:ss.sssZ`. */
  ts: string;
  views?: number;
  likes?: number;
  comments?: number;
  raw?: unknown;
}

/**
 * Lifecycle of a recommendation emitted by the digest loop.
 *
 * Allowed flow: proposed -> sent -> accepted | dismissed. Only these
 * three forward edges are legal; "accepted" and "dismissed" are
 * terminal-ish - no transition may leave them. A same-status write is
 * an idempotent no-op. Enforced by
 * StateStore.updateRecommendationStatus (src/store/contract.ts).
 */
export type RecommendationStatus = "proposed" | "sent" | "accepted" | "dismissed";

/** A concrete post brief recommended to the developer (digest output).
 * `ts` is a normalized UTC ISO-8601 timestamp (see
 * {@link ContentTimestamps}). */
export interface Recommendation {
  id: string;
  /** Normalized UTC ISO-8601, `YYYY-MM-DDTHH:mm:ss.sssZ`. */
  ts: string;
  topic: string;
  objective: Objective;
  platform: Platform;
  status: RecommendationStatus;
}

/** Result of a profile audit run (item_08-legacy); `findings` are
 * human-readable audit observations for the digest. `ts` is a normalized
 * UTC ISO-8601 timestamp (see {@link ContentTimestamps}) - the store's
 * latestReport selects the max `ts` lexicographically. */
export interface ProfileReport {
  id: string;
  /** Normalized UTC ISO-8601, `YYYY-MM-DDTHH:mm:ss.sssZ`. */
  ts: string;
  platform: Platform;
  findings: string[];
}

/** Rank of each pipeline status along the linear progression. */
const PIPELINE_RANK: Record<PipelineStatus, number> = {
  idea: 0,
  brief: 1,
  draft: 2,
  moderation: 3,
  approved: 4,
  queued: 5,
  published: 6,
  measured: 7,
};

/**
 * Pure status state machine. Takes an item and a target status, returns
 * a NEW item (the input is never mutated).
 *
 * Allowed moves:
 * - Forward along the pipeline: any `to` whose rank is higher than the
 *   current status' rank (skipping stages is allowed, e.g.
 *   draft -> approved when moderation is waived).
 * - Backward: exactly one edge, draft -> brief (edit/rework).
 * - Into a terminal status: any non-terminal status may transition to
 *   "failed" or "rejected" (operational failure / editorial rejection
 *   can happen at any stage).
 * - Same status: a no-op that returns the item unchanged (idempotent
 *   re-application), even for terminal statuses.
 *
 * Everything else throws {@link InvalidTransition}: backward moves other
 * than draft -> brief, and ANY move out of "failed"/"rejected" (they are
 * terminal - no outbound edges, including between each other).
 *
 * Side effects on the returned copy: `timestamps.updated_at` is set to
 * `now`; a transition into "published" also sets `published_at`.
 */
export function transitionStatus(
  item: ContentItem,
  to: ContentStatus,
  now: Date = new Date(),
): ContentItem {
  const from = item.status;

  if (to === from) {
    return item;
  }
  if (isTerminal(from)) {
    throw new InvalidTransition(from, to);
  }

  const allowed =
    isTerminal(to) || // terminalizing move, allowed from any non-terminal status
    PIPELINE_RANK[to] > PIPELINE_RANK[from] ||
    (from === "draft" && to === "brief"); // the single backward edge

  if (!allowed) {
    throw new InvalidTransition(from, to);
  }

  const timestamps: ContentTimestamps = {
    ...item.timestamps,
    updated_at: now.toISOString(),
  };
  if (to === "published") {
    timestamps.published_at = now.toISOString();
  }
  return { ...item, status: to, timestamps };
}
