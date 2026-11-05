/**
 * Cadence + pillar checker (roadmap item_07).
 *
 * {@link checkCadence} compares the windowed publish history in the
 * store (items in "published"/"measured" status, scored by
 * `published_at` with `updated_at` as fallback) against the
 * {@link BrandCharter} targets and emits human-readable flags:
 *
 * - `"<platform> below cadence"` - windowed posts on the platform fell
 *   below `floor(posts_per_week * window_days / 7)`. Suppressed when a
 *   post for that platform went out within {@link FRESH_WINDOW_MS}
 *   (a fresh post means cadence is actively being kept).
 * - `"pillar imbalance: <objective>"` - more than
 *   `thresholds.pillar_imbalance_pct`% of windowed posts share one
 *   objective.
 * - `"objective gap: <objective>"` - zero windowed posts serve a
 *   pillar the charter declares.
 *
 * Digest integration: digest.ts exposes no pre-send extension seam
 * today, so the flags are produced standalone - a caller (the
 * scheduler loop, wiring lands in item_08) appends them via
 * {@link cadenceDigestSection} / {@link injectFlagsIntoDigest} before
 * send. The charter itself is likewise meant to feed the strategist's
 * role context; that wiring is item_08's as well.
 */
import { type Objective, PLATFORMS, type Platform } from "../model/contract.js";
import type { StateStore } from "../store/contract.js";
import type { BrandCharter } from "./charter.js";

/** A post published within this window counts as "fresh" and suppresses below-cadence flags. */
export const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const OBJECTIVES: readonly Objective[] = ["authority", "proof", "community"];

export interface CheckCadenceOptions {
  /** Clock injection for tests; defaults to wall time. */
  now?: Date;
  /** Scoring window in days; defaults to `charter.window_days`. */
  windowDays?: number;
}

export interface CadenceStats {
  /** Windowed post count per platform (an item counts once per platform_ref). */
  perPlatform: Record<Platform, number>;
  /** Windowed post count per objective (an item counts once). */
  perObjective: Record<Objective, number>;
  /** The window actually scored, in days. */
  window_days: number;
}

export interface CadenceResult {
  flags: string[];
  stats: CadenceStats;
}

/** Timestamp an item is scored by: publish time, falling back to last update. */
function publishTs(item: { timestamps: { published_at?: string; updated_at: string } }): string {
  return item.timestamps.published_at ?? item.timestamps.updated_at;
}

/**
 * Score the store's publish history against the charter.
 *
 * @returns flags in deterministic order: per-platform cadence flags in
 *   charter `cadence` order, then the pillar-imbalance flag, then
 *   objective gaps in charter `content_pillars` order.
 */
export function checkCadence(
  store: StateStore,
  charter: BrandCharter,
  opts: CheckCadenceOptions = {},
): CadenceResult {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? charter.window_days;
  const windowStartMs = now.getTime() - windowDays * MS_PER_DAY;

  const windowed = [...store.getByStatus("published"), ...store.getByStatus("measured")].filter(
    (item) => {
      const ts = Date.parse(publishTs(item));
      return !Number.isNaN(ts) && ts >= windowStartMs && ts <= now.getTime();
    },
  );

  const perPlatform = {} as Record<Platform, number>;
  for (const p of PLATFORMS) {
    perPlatform[p] = 0;
  }
  const perObjective = {} as Record<Objective, number>;
  for (const o of OBJECTIVES) {
    perObjective[o] = 0;
  }

  const freshPlatforms = new Set<Platform>();
  for (const item of windowed) {
    perObjective[item.objective] += 1;
    const fresh = now.getTime() - Date.parse(publishTs(item)) <= FRESH_WINDOW_MS;
    for (const p of item.platform_refs) {
      perPlatform[p] += 1;
      if (fresh) {
        freshPlatforms.add(p);
      }
    }
  }

  const flags: string[] = [];

  for (const target of charter.cadence) {
    const required = Math.floor((target.posts_per_week * windowDays) / 7);
    if (perPlatform[target.platform] < required && !freshPlatforms.has(target.platform)) {
      flags.push(`${target.platform} below cadence`);
    }
  }

  const total = windowed.length;
  if (total > 0) {
    const top = OBJECTIVES.reduce((a, b) => (perObjective[a] >= perObjective[b] ? a : b));
    if ((perObjective[top] * 100) / total > charter.thresholds.pillar_imbalance_pct) {
      flags.push(`pillar imbalance: ${top}`);
    }
  }

  const declared = new Set<Objective>();
  for (const pillar of charter.content_pillars) {
    if (!declared.has(pillar.objective)) {
      declared.add(pillar.objective);
      if (perObjective[pillar.objective] === 0) {
        flags.push(`objective gap: ${pillar.objective}`);
      }
    }
  }

  return {
    flags,
    stats: { perPlatform, perObjective, window_days: windowDays },
  };
}

/** Render the checker's flags as a digest-appendable text section. */
export function cadenceDigestSection(result: CadenceResult): string {
  const lines = [`Cadence (${result.stats.window_days}d window):`];
  if (result.flags.length === 0) {
    lines.push("- on track");
  } else {
    for (const flag of result.flags) {
      lines.push(`- ${flag}`);
    }
  }
  return lines.join("\n");
}

/**
 * Append the cadence section to a digest text. Callable by the
 * scheduler/digest path once item_08 wires the checker into the digest
 * tick; kept standalone because digest.ts has no pre-send extension
 * seam to hook today.
 */
export function injectFlagsIntoDigest(digestText: string, result: CadenceResult): string {
  return `${digestText}\n\n${cadenceDigestSection(result)}`;
}
