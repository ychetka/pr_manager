/**
 * Metrics collector runner (roadmap item_05).
 *
 * {@link collectMetrics} walks every ContentItem eligible for
 * measurement - status "published" (never measured yet) plus
 * "measured" (periodic re-collection) - groups them per platform via
 * `platform_refs`, delegates to the matching {@link PlatformCollector}
 * and persists returned snapshots through
 * `StateStore.recordMetric`. After a successful first collection a
 * "published" item is moved to "measured" via transitionStatus, per
 * the store contract's pendingAudit doc; failed/errored items stay
 * "published" so the next run retries them.
 *
 * The interface is platform-agnostic: a LinkedIn collector drops in by
 * implementing PlatformCollector and being added to the `collectors`
 * option - no runner rework.
 *
 * Failure surfacing (v1): the ContentStatus state machine has no
 * "metrics_error" status and hacking one in would violate the model
 * contract. Instead, per-item failures are returned in
 * {@link MetricsRunResult.errored} (item_id + code + message) and
 * echoed to the warnings log; a dedicated metrics_error marker would
 * need a contract amendment - see the item_05 deviation note.
 */
import { causeMessage, isServiceError } from "../errors.js";
import {
  type ContentItem,
  type ContentStatus,
  type MetricSnapshot,
  type Platform,
  transitionStatus,
} from "../model/contract.js";
import type { StateStore } from "../store/contract.js";
import { VkCollector } from "./vk.js";

/** An item the run deliberately did not measure, with the reason why. */
export interface MetricsItemSkip {
  item_id: string;
  reason: string;
}

/**
 * An item whose measurement FAILED - the v1 stand-in for a
 * "metrics_error" item marker (the status enum has no such value;
 * see the module docstring).
 */
export interface MetricsItemError {
  item_id: string;
  /** Machine-readable code ("metrics_auth", "metrics_upstream", ...). */
  code: string;
  message: string;
}

/** Aggregate outcome of {@link collectMetrics}. */
export interface MetricsRunResult {
  /** MetricSnapshots persisted via store.recordMetric this run. */
  collected: number;
  /** Items deliberately not measured, each with its reason. */
  skipped: MetricsItemSkip[];
  /** Items whose measurement failed (the metrics_error surrogate). */
  errored: MetricsItemError[];
  /** Non-fatal problems worth surfacing in logs and the digest. */
  warnings: string[];
}

/**
 * Per-item outcome a {@link PlatformCollector} reports back to the
 * runner. "metric" carries a ready-to-persist snapshot; "skip" and
 * "error" are the two non-success dispositions (skipped = nothing to
 * measure / upstream said no, error = the measurement itself failed).
 */
export type CollectOutcome =
  | { kind: "metric"; item_id: string; snapshot: MetricSnapshot }
  | { kind: "skip"; item_id: string; reason: string }
  | { kind: "error"; item_id: string; code: string; message: string };

/** Services the runner hands to a collector. */
export interface CollectContext {
  /** Clock (normalized UTC ISO-8601 stamps come from `now().toISOString()`). */
  now: () => Date;
  /** Warning sink; entries land in {@link MetricsRunResult.warnings}. */
  warn: (msg: string) => void;
}

/**
 * Measures one platform's worth of items. Implementations own all
 * upstream specifics (endpoint, auth, batching, retries) and must
 * return one {@link CollectOutcome} per input item - extra outcomes
 * (e.g. one snapshot per post ref) are allowed; items missing from
 * the result are counted as skipped by the runner. A collector-level
 * failure that prevents ANY measurement (e.g. missing credentials)
 * may instead throw, which the runner maps onto every item of that
 * platform without killing the rest of the run.
 */
export interface PlatformCollector {
  readonly platform: Platform;
  collect(items: readonly ContentItem[], ctx: CollectContext): Promise<CollectOutcome[]>;
}

export interface CollectMetricsOptions {
  /**
   * Collectors to dispatch on; defaults to {@link defaultCollectors}
   * (VK only for v1 - LinkedIn is deferred per the roadmap).
   */
  collectors?: readonly PlatformCollector[];
  /** Clock injection for tests; defaults to wall time. */
  now?: () => Date;
  /** Warning sink for tests; defaults to result.warnings only. */
  warn?: (msg: string) => void;
}

/** The built-in collector set: VK only; LinkedIn is deferred (roadmap item_05). */
export function defaultCollectors(): PlatformCollector[] {
  return [new VkCollector()];
}

/**
 * Statuses eligible for measurement: "published" (live upstream, not
 * yet measured) and "measured" (re-collection refreshes the series -
 * recordMetric appends immutable snapshots, so re-measuring is safe).
 */
const MEASURABLE_STATUSES: readonly ContentStatus[] = ["published", "measured"];

/** Run one metrics pass over all measurable items in the store. */
export async function collectMetrics(
  store: StateStore,
  opts: CollectMetricsOptions = {},
): Promise<MetricsRunResult> {
  const collectors = opts.collectors ?? defaultCollectors();
  const byPlatform = new Map<Platform, PlatformCollector>();
  for (const c of collectors) {
    byPlatform.set(c.platform, c);
  }

  const result: MetricsRunResult = { collected: 0, skipped: [], errored: [], warnings: [] };
  const warn = (msg: string): void => {
    result.warnings.push(msg);
    opts.warn?.(msg);
  };
  const ctx: CollectContext = { now: opts.now ?? (() => new Date()), warn };

  const items: ContentItem[] = [];
  for (const status of MEASURABLE_STATUSES) {
    items.push(...store.getByStatus(status));
  }

  // Dispatch: an item goes to every platform it references that has a
  // collector (a cross-posted item is measured on each platform).
  const assignments = new Map<PlatformCollector, ContentItem[]>();
  for (const item of items) {
    const covered: PlatformCollector[] = [];
    const uncovered: Platform[] = [];
    for (const ref of item.platform_refs) {
      const collector = byPlatform.get(ref);
      if (collector === undefined) {
        uncovered.push(ref);
      } else if (!covered.includes(collector)) {
        covered.push(collector);
      }
    }
    if (item.platform_refs.length === 0) {
      result.skipped.push({ item_id: item.id, reason: "no platform_refs" });
      continue;
    }
    if (uncovered.length > 0) {
      warn(`item ${item.id}: no collector for platform_refs [${uncovered.join(", ")}]`);
    }
    if (covered.length === 0) {
      result.skipped.push({
        item_id: item.id,
        reason: `no collector for platform_refs [${item.platform_refs.join(", ")}]`,
      });
      continue;
    }
    for (const collector of covered) {
      const list = assignments.get(collector) ?? [];
      list.push(item);
      assignments.set(collector, list);
    }
  }

  for (const [collector, platformItems] of assignments) {
    let outcomes: CollectOutcome[];
    try {
      outcomes = await collector.collect(platformItems, ctx);
    } catch (e) {
      // Collector-level failure (e.g. missing credentials): mark every
      // item of this platform errored and keep other platforms going.
      const code = isServiceError(e) ? e.code : "metrics_upstream";
      const message = isServiceError(e) ? (e.detail ?? causeMessage(e)) : causeMessage(e);
      warn(`${collector.platform}: ${message}`);
      for (const item of platformItems) {
        result.errored.push({ item_id: item.id, code, message });
      }
      continue;
    }
    applyOutcomes(store, collector.platform, platformItems, outcomes, ctx, result, warn);
  }
  return result;
}

function applyOutcomes(
  store: StateStore,
  platform: Platform,
  items: readonly ContentItem[],
  outcomes: readonly CollectOutcome[],
  ctx: CollectContext,
  result: MetricsRunResult,
  warn: (msg: string) => void,
): void {
  const seen = new Set<string>();
  for (const outcome of outcomes) {
    seen.add(outcome.item_id);
    if (outcome.kind === "metric") {
      store.recordMetric(outcome.snapshot);
      result.collected += 1;
      markMeasured(store, items, outcome.item_id, ctx, warn);
    } else if (outcome.kind === "skip") {
      result.skipped.push({ item_id: outcome.item_id, reason: outcome.reason });
    } else {
      result.errored.push({
        item_id: outcome.item_id,
        code: outcome.code,
        message: outcome.message,
      });
      warn(`${platform}: item ${outcome.item_id}: ${outcome.code}: ${outcome.message}`);
    }
  }
  for (const item of items) {
    if (!seen.has(item.id)) {
      result.skipped.push({ item_id: item.id, reason: "collector returned no outcome" });
      warn(`${platform}: item ${item.id}: collector returned no outcome`);
    }
  }
}

/**
 * Move a successfully measured "published" item to "measured" (the
 * pendingAudit contract: items leave the audit queue once measured).
 * "measured" items need no write. A store-side rejection is warned,
 * not fatal - the snapshot is already persisted.
 */
function markMeasured(
  store: StateStore,
  items: readonly ContentItem[],
  itemId: string,
  ctx: CollectContext,
  warn: (msg: string) => void,
): void {
  const item = items.find((i) => i.id === itemId);
  if (item === undefined || item.status !== "published") {
    return;
  }
  try {
    store.upsertContentItem(transitionStatus(item, "measured", ctx.now()));
  } catch (e) {
    warn(
      `item ${itemId}: metrics collected but status move to "measured" failed: ${causeMessage(e)}`,
    );
  }
}
