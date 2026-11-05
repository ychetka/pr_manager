/**
 * Built-in n8n-state source parsers (roadmap item_04).
 *
 * Each maps one logical record (per INGEST_GRANULARITY: a whole file
 * body for drafts/queue, one JSONL line for publish_log) into a
 * Partial<ContentItem>. Boundary contract (src/ingest/contract.ts):
 * `null` = skippable record, `throw` = warning + skipped.
 *
 * Shared conventions:
 * - Internal item id is `n8n:<upstream_id>` for ALL sources: upstream
 *   reuses the same id as a post travels drafts -> queue -> publish
 *   log, so all sources update ONE ContentItem that moves forward
 *   through the pipeline (fetch -> transitionStatus -> upsert).
 * - external_id: drafts/queue use the bare upstream id; publish_log
 *   uses `publish_log:<upstream_id>` - the log is an append-only event
 *   stream where one upstream id legitimately appears in many lines
 *   (retry chains), and the prefix documents that the key comes from
 *   the log, not an entity file. Re-ingest of the same line still
 *   dedupes on (publish_log, publish_log:<id>) + same item id.
 * - `objective`: upstream carries no pillar tag, so parsers set none;
 *   the runner defaults it (see runner.ts). TODO(item_07): derive from
 *   BrandCharter/topic keywords when the charter lands.
 * - Every parser attaches the parsed upstream record as `raw` (the
 *   ingest-side extension SqliteStore persists verbatim - e.g. a
 *   `failed` log line keeps its `maybe_live` flag there).
 */
import { basename, dirname } from "node:path";
import { type ContentItem, type ContentStatus, parsePlatform } from "../model/contract.js";
import type { ParseContext, ParserName, SourceParser } from "./contract.js";

/** Upstream payload carrier: an optional `raw` the store persists (see sqlite.ts). */
export type IngestPartial = Partial<ContentItem> & { raw?: unknown };

/** Internal id shared by all n8n sources for one upstream entity. */
export function n8nItemId(upstreamId: string): string {
  return `n8n:${upstreamId}`;
}

/** Normalize an upstream timestamp to the contract's `YYYY-MM-DDTHH:mm:ss.sssZ`; undefined if invalid. */
function normTs(s: unknown): string | undefined {
  if (typeof s !== "string") {
    return undefined;
  }
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function parseJsonObject(raw: string, ctx: ParseContext): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw); // throws -> warning + skipped at the runner
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`record is not a JSON object at ${ctx.path}`);
  }
  return parsed as Record<string, unknown>;
}

/** platform_refs from an optional upstream platform string; unknown values throw UnknownPlatform. */
function platformRefs(rec: Record<string, unknown>): ContentItem["platform_refs"] {
  const p = rec.platform;
  if (p === undefined || p === null || p === "") {
    return [];
  }
  if (typeof p !== "string") {
    throw new Error(`non-string platform: ${JSON.stringify(p)}`);
  }
  return [parsePlatform(p)];
}

/** Upstream id from the record's `id` field, falling back to the file basename. */
function upstreamIdOf(rec: Record<string, unknown>, ctx: ParseContext): string {
  if (typeof rec.id === "string" && rec.id.trim() !== "") {
    return rec.id;
  }
  const base = basename(ctx.path).replace(/\.json$/i, "");
  if (base !== "") {
    return base;
  }
  throw new Error(`record has no id and none derivable at ${ctx.path}`);
}

/* ------------------------------------------------------------------ */
/* state/drafts/*.json                                                 */
/* ------------------------------------------------------------------ */

/**
 * Draft status mapping (upstream -> pipeline):
 *   pending  -> moderation   (waiting in the Telegram moderation queue)
 *   approved -> approved     (moderator accepted, queue pickup pending)
 *   rejected -> rejected     (terminal: moderator declined)
 *   draft    -> draft        (still being authored)
 * Anything else throws -> warning + skipped.
 */
const DRAFT_STATUS: Readonly<Record<string, ContentStatus>> = {
  pending: "moderation",
  approved: "approved",
  rejected: "rejected",
  draft: "draft",
};

export const n8nDraftsParser: SourceParser = (raw, ctx) => {
  const rec = parseJsonObject(raw, ctx);
  if (typeof rec.status !== "string" || !(rec.status in DRAFT_STATUS)) {
    throw new Error(`unknown draft status ${JSON.stringify(rec.status)} at ${ctx.path}`);
  }
  const upstreamId = upstreamIdOf(rec, ctx);
  const out: IngestPartial = {
    id: n8nItemId(upstreamId),
    external_id: upstreamId,
    status: DRAFT_STATUS[rec.status],
    platform_refs: platformRefs(rec),
    published_urls: [],
    raw: rec,
  };
  const created = normTs(rec.created_at);
  if (created !== undefined) {
    out.timestamps = { created_at: created, updated_at: created };
  }
  return out;
};

/* ------------------------------------------------------------------ */
/* queue/publish/*.json (root + processing/done/failed/skipped)        */
/* ------------------------------------------------------------------ */

/**
 * Queue directory -> pipeline status (the FILE has no status field; its
 * subdirectory IS the state machine position):
 *   publish/ (root), processing -> queued
 *   done                        -> published
 *   failed                      -> failed   (terminal)
 *   skipped                     -> rejected (terminal: never dispatched)
 * Any other subdirectory throws -> warning + skipped.
 */
const QUEUE_SUBDIR_STATUS: Readonly<Record<string, ContentStatus>> = {
  publish: "queued", // files directly under queue/publish/
  processing: "queued",
  done: "published",
  failed: "failed",
  skipped: "rejected",
};

export const n8nQueueParser: SourceParser = (raw, ctx) => {
  const rec = parseJsonObject(raw, ctx);
  const subdir = basename(dirname(ctx.path));
  const status = QUEUE_SUBDIR_STATUS[subdir];
  if (status === undefined) {
    throw new Error(`queue record under unmapped subdirectory at ${ctx.path}`);
  }
  const upstreamId = upstreamIdOf(rec, ctx);
  const out: IngestPartial = {
    id: n8nItemId(upstreamId),
    external_id: upstreamId,
    status,
    platform_refs: platformRefs(rec),
    published_urls: [],
    raw: rec,
  };
  const ts = normTs(rec.approved_at);
  if (ts !== undefined) {
    const timestamps: NonNullable<IngestPartial["timestamps"]> = {
      created_at: ts,
      updated_at: ts,
    };
    if (status === "published") {
      timestamps.published_at = ts;
    }
    out.timestamps = timestamps;
  }
  return out;
};

/* ------------------------------------------------------------------ */
/* logs/publish.jsonl (one record per line)                            */
/* ------------------------------------------------------------------ */

/** VK post reference inside a `via` string, e.g. "vk api wall.post 29642349_300 ...". */
const VK_WALL_POST = /wall\.post (\d+_\d+)/;

/**
 * Publish-log status mapping:
 *   published -> published  (published_urls from `via` wall.post ref)
 *   failed    -> failed     (terminal; `maybe_live`/`error` kept in raw)
 *   skipped / retry-requeued / stuck-claim-recovered /
 *   test-published-deleted / anything else -> null (skip, info-level:
 *   these are operational events, not pipeline states - the queue
 *   directory already carries the item's real position).
 */
export const n8nPublishLogParser: SourceParser = (raw, ctx) => {
  const rec = parseJsonObject(raw, ctx);
  const status = rec.status;
  if (status !== "published" && status !== "failed") {
    return null;
  }
  // Identity: `id` wins; `file` (the queue filename) is the documented
  // fallback on lines the publisher wrote without an id.
  let upstreamId: string;
  if (typeof rec.id === "string" && rec.id.trim() !== "") {
    upstreamId = rec.id;
  } else if (typeof rec.file === "string" && rec.file.trim() !== "") {
    upstreamId = rec.file.replace(/\.json$/i, "");
  } else {
    return null; // no identity to dedupe on
  }

  const out: IngestPartial = {
    id: n8nItemId(upstreamId),
    external_id: `publish_log:${upstreamId}`,
    status: status as ContentStatus,
    platform_refs: platformRefs(rec),
    published_urls: [],
    raw: rec,
  };
  if (status === "published" && typeof rec.via === "string") {
    const m = VK_WALL_POST.exec(rec.via);
    if (m !== null) {
      out.published_urls = [`https://vk.com/wall${m[1]}`];
    }
  }
  const ts = normTs(rec.ts);
  if (ts !== undefined) {
    const timestamps: NonNullable<IngestPartial["timestamps"]> = {
      created_at: ts,
      updated_at: ts,
    };
    if (status === "published") {
      timestamps.published_at = ts;
    }
    out.timestamps = timestamps;
  }
  return out;
};

/** Registry resolving ParserName refs in IngestSource declarations. */
export const PARSER_REGISTRY: Readonly<Record<ParserName, SourceParser>> = {
  "n8n-drafts": n8nDraftsParser,
  "n8n-queue": n8nQueueParser,
  "n8n-publish-log": n8nPublishLogParser,
};
