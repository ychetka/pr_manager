/**
 * BrandCharter loading + validation (roadmap item_07).
 *
 * `brand.yaml` at the repo root declares the personal-brand contract:
 * audience, content pillars mapped onto model Objectives, tone, target
 * cadence per platform, the scoring window and flag thresholds.
 * {@link loadCharter} parses it (via the `yaml` dependency) into a
 * typed {@link BrandCharter} and validates it eagerly - a malformed
 * charter fails at load time with a plain Error (load happens at
 * startup/tick setup, before any service-error context applies,
 * matching src/config.ts policy).
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { type Objective, PLATFORMS, type Platform } from "../model/contract.js";

/**
 * Canonical list of the model Objective union. Kept here because
 * src/model/contract.ts (item_02 scope, outside item_07's may_edit)
 * exports only the type; the checker imports this single copy so the
 * union cannot drift between the two cadence files.
 */
export const OBJECTIVES: readonly Objective[] = ["authority", "proof", "community"];

/** Env var loadCharter reads when no explicit path argument is given. */
export const ENV_BRAND_CHARTER_PATH = "BRAND_CHARTER_PATH";

/** Charter path used when neither the arg nor {@link ENV_BRAND_CHARTER_PATH} is set. */
export const DEFAULT_CHARTER_PATH = "./brand.yaml";

/** Fallback scoring window when the charter omits `window_days`. */
export const DEFAULT_WINDOW_DAYS = 14;

/** Fallback pillar-imbalance threshold (%) when the charter omits `thresholds`. */
export const DEFAULT_PILLAR_IMBALANCE_PCT = 70;

/** One content pillar mapped onto the Objective the pipeline scores. */
export interface ContentPillar {
  name: string;
  objective: Objective;
  description?: string;
}

/** Target publish cadence for one platform. */
export interface PlatformCadence {
  platform: Platform;
  posts_per_week: number;
}

/** Flag thresholds; `pillar_imbalance_pct` defaults to {@link DEFAULT_PILLAR_IMBALANCE_PCT}. */
export interface CharterThresholds {
  pillar_imbalance_pct: number;
}

/** Parsed, validated brand.yaml. */
export interface BrandCharter {
  audience: string;
  content_pillars: ContentPillar[];
  tone: string;
  cadence: PlatformCadence[];
  window_days: number;
  thresholds: CharterThresholds;
}

function fail(msg: string): never {
  throw new Error(`brand charter: ${msg}`);
}

function asRecord(v: unknown, field: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    fail(`${field} must be a mapping`);
  }
  return v as Record<string, unknown>;
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    fail(`${field} must be a non-empty string`);
  }
  return v.trim();
}

function requireNumber(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    fail(`${field} must be a number`);
  }
  return v;
}

function parsePillars(v: unknown): ContentPillar[] {
  if (!Array.isArray(v) || v.length === 0) {
    fail("content_pillars must be a non-empty list");
  }
  return v.map((raw, i): ContentPillar => {
    const r = asRecord(raw, `content_pillars[${i}]`);
    const objective = r.objective;
    if (typeof objective !== "string" || !(OBJECTIVES as readonly string[]).includes(objective)) {
      fail(
        `content_pillars[${i}].objective must be one of ${OBJECTIVES.join("|")}, ` +
          `got ${JSON.stringify(objective)}`,
      );
    }
    const pillar: ContentPillar = {
      name: requireString(r.name, `content_pillars[${i}].name`),
      objective: objective as Objective,
    };
    if (r.description !== undefined) {
      pillar.description = requireString(r.description, `content_pillars[${i}].description`);
    }
    return pillar;
  });
}

function parseCadence(v: unknown): PlatformCadence[] {
  if (!Array.isArray(v) || v.length === 0) {
    fail("cadence must be a non-empty list");
  }
  const seen = new Set<string>();
  return v.map((raw, i): PlatformCadence => {
    const r = asRecord(raw, `cadence[${i}]`);
    const platform = r.platform;
    if (typeof platform !== "string" || !(PLATFORMS as readonly string[]).includes(platform)) {
      fail(
        `cadence[${i}].platform must be one of ${PLATFORMS.join("|")}, ` +
          `got ${JSON.stringify(platform)}`,
      );
    }
    if (seen.has(platform)) {
      fail(`cadence[${i}].platform duplicates an earlier entry: ${JSON.stringify(platform)}`);
    }
    seen.add(platform);
    const posts_per_week = requireNumber(r.posts_per_week, `cadence[${i}].posts_per_week`);
    if (posts_per_week < 0) {
      fail(`cadence[${i}].posts_per_week must be >= 0, got ${posts_per_week}`);
    }
    return { platform: platform as Platform, posts_per_week };
  });
}

/**
 * Load and validate a BrandCharter.
 *
 * Path resolution: explicit `path` > env {@link ENV_BRAND_CHARTER_PATH}
 * > {@link DEFAULT_CHARTER_PATH} (resolved against the process cwd).
 * Missing/optional sections fall back to documented defaults
 * (`window_days` 14, `thresholds.pillar_imbalance_pct` 70).
 *
 * @throws {Error} plain Error on read failure, YAML parse failure or
 *   any validation miss (required fields, numeric cadence, objectives
 *   outside the model Objective union, unknown platforms).
 */
export function loadCharter(path?: string): BrandCharter {
  const envPath = process.env[ENV_BRAND_CHARTER_PATH]?.trim();
  const resolved = path ?? (envPath || DEFAULT_CHARTER_PATH);

  let raw: string;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch (e) {
    throw new Error(
      `brand charter: cannot read ${resolved}: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }

  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (e) {
    throw new Error(
      `brand charter: YAML parse failed in ${resolved}: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  const root = asRecord(doc, "document root");

  const charter: BrandCharter = {
    audience: requireString(root.audience, "audience"),
    content_pillars: parsePillars(root.content_pillars),
    tone: requireString(root.tone, "tone"),
    cadence: parseCadence(root.cadence),
    window_days: DEFAULT_WINDOW_DAYS,
    thresholds: { pillar_imbalance_pct: DEFAULT_PILLAR_IMBALANCE_PCT },
  };

  if (root.window_days !== undefined) {
    const days = requireNumber(root.window_days, "window_days");
    if (!Number.isInteger(days) || days <= 0) {
      fail(`window_days must be a positive integer, got ${days}`);
    }
    charter.window_days = days;
  }

  if (root.thresholds !== undefined) {
    const t = asRecord(root.thresholds, "thresholds");
    if (t.pillar_imbalance_pct !== undefined) {
      const pct = requireNumber(t.pillar_imbalance_pct, "thresholds.pillar_imbalance_pct");
      if (pct <= 0 || pct > 100) {
        fail(`thresholds.pillar_imbalance_pct must be in (0, 100], got ${pct}`);
      }
      charter.thresholds.pillar_imbalance_pct = pct;
    }
  }

  return charter;
}
