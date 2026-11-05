/**
 * Ingester runner (roadmap item_04).
 *
 * {@link ingestAll} verifies the mounted n8n-state volume with
 * checkMountHealth FIRST - fail-closed: a broken/empty mount throws
 * "ingest_unmounted" and nothing is read or written. It then walks
 * each IngestSource at its contract granularity (file for
 * drafts/queue, line for publish_log), maps records through the
 * source's parser and persists results via
 * fetch -> transitionStatus -> upsert (the store's recommended
 * regression guard rejects any other write pattern).
 *
 * Bookkeeping fields the runner fills around the parser's partial:
 * - `source_kind`: the IngestSourceKind ("drafts" | "queue" |
 *   "publish_log").
 * - `objective`: upstream carries no pillar tag; deterministic default
 *   "proof". TODO(item_07): derive from BrandCharter once it lands.
 * - `timestamps.updated_at`: ingest time; `created_at` keeps the
 *   upstream creation time when the parser supplies one.
 *
 * Merge semantics on re-encounter (idempotent re-ingest): same-status
 * writes are no-op updates; forward moves travel through
 * transitionStatus (published_at is set once, preferring the upstream
 * timestamp when the parser provides one); `platform_refs` and
 * `published_urls` merge as set-union so a later source enriches
 * rather than clobbers earlier data. A parse `null` counts as skipped;
 * a throw counts as skipped + warning. Neither kills the pass.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { causeMessage } from "../errors.js";
import {
  type ContentItem,
  type ContentStatus,
  InvalidTransition,
  transitionStatus,
} from "../model/contract.js";
import type { StateStore } from "../store/contract.js";
import {
  checkMountHealth,
  DEFAULT_INGEST_SOURCES,
  INGEST_GRANULARITY,
  type IngestResult,
  type IngestSource,
  type MountHealthOptions,
  type ParseContext,
  type SourceParser,
} from "./contract.js";
import { PARSER_REGISTRY } from "./parsers.js";

export interface IngestOptions {
  /** Extra mount verification passed through to checkMountHealth. */
  mount?: MountHealthOptions;
  /** Clock injection for tests; defaults to wall time. */
  now?: () => Date;
}

/** Default objective for upstream records that carry no pillar tag. */
export const DEFAULT_INGEST_OBJECTIVE: ContentItem["objective"] = "proof";

interface RawRecord {
  raw: string;
  ctx: ParseContext;
}

function resolveParser(source: IngestSource): SourceParser {
  if (typeof source.parser === "function") {
    return source.parser;
  }
  const parser = PARSER_REGISTRY[source.parser];
  if (parser === undefined) {
    throw new Error(`unknown parser name: ${source.parser}`);
  }
  return parser;
}

async function listFiles(dir: string, ext: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listFiles(p, ext)));
    } else if (e.isFile() && e.name.endsWith(ext)) {
      out.push(p);
    }
  }
  return out.sort();
}

/**
 * Per-kind basename filter for line-granularity sources. The mount's
 * `logs/` holds several JSONL streams (content-gen, moderation,
 * publish); the publish_log source owns only `publish*.jsonl` - the
 * glob tolerates rotation (publish-YYYY-MM.jsonl) while leaving the
 * other streams to future sources instead of counting every one of
 * their lines as a skipped record.
 */
const LINE_FILE_FILTER: Partial<Record<IngestSource["kind"], RegExp>> = {
  publish_log: /^publish.*\.jsonl$/,
};

/** Slice a source directory into per-record inputs per INGEST_GRANULARITY. */
async function* recordsOf(source: IngestSource, root: string): AsyncGenerator<RawRecord> {
  const dir = join(root, source.path);
  const granularity = INGEST_GRANULARITY[source.kind];
  if (granularity === "file") {
    for (const file of await listFiles(dir, ".json")) {
      yield {
        raw: await readFile(file, "utf8"),
        ctx: { kind: source.kind, path: relative(root, file).split(sep).join("/") },
      };
    }
    return;
  }
  // line granularity: every line of every matching *.jsonl file is a record
  const filter = LINE_FILE_FILTER[source.kind] ?? /\.jsonl$/;
  for (const file of await listFiles(dir, ".jsonl")) {
    const rel = relative(root, file).split(sep).join("/");
    if (!filter.test(basename(file))) {
      continue;
    }
    const body = await readFile(file, "utf8");
    let lineNo = 0;
    for (const line of body.split("\n")) {
      lineNo += 1;
      if (line.trim() === "") {
        continue; // blank lines are not records (trailing newline etc.)
      }
      yield { raw: line, ctx: { kind: source.kind, path: rel, line_no: lineNo } };
    }
  }
}

function locate(ctx: ParseContext): string {
  return ctx.line_no === undefined ? ctx.path : `${ctx.path}:${ctx.line_no}`;
}

function union<T>(a: T[], b: T[] | undefined): T[] {
  return [...new Set([...a, ...(b ?? [])])];
}

/**
 * Run one ingest pass over `sources` under `root`.
 *
 * @throws ServiceError "ingest_unmounted" when the mount fails health
 *   verification (fail-closed).
 */
export async function ingestAll(
  store: StateStore,
  root: string,
  sources: readonly IngestSource[] = DEFAULT_INGEST_SOURCES,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  await checkMountHealth(root, opts.mount);

  const now = opts.now?.() ?? new Date();
  const nowIso = now.toISOString();
  const result: IngestResult = { items: 0, skipped: 0, warnings: [] };

  for (const source of sources) {
    const parser = resolveParser(source);
    for await (const { raw, ctx } of recordsOf(source, root)) {
      const outcome = parseRecord(parser, raw, ctx, result);
      if (outcome === null) {
        continue;
      }
      const item = buildItem(outcome, source, nowIso);
      if (item === null) {
        result.skipped += 1;
        result.warnings.push(`${locate(ctx)}: parser yielded no identity (id/external_id)`);
        continue;
      }
      try {
        upsertMerged(store, item, now);
        result.items += 1;
      } catch (e) {
        // InvalidTransition (status regression / terminal escape) and
        // Conflict (idempotency-key claim by another id) are per-record
        // failures: warn + skip, never kill the pass.
        result.skipped += 1;
        result.warnings.push(`${locate(ctx)}: ${describe(e)}`);
      }
    }
  }
  return result;
}

/** Run the parser over one record; null/throw both mean "skipped". */
function parseRecord(
  parser: SourceParser,
  raw: string,
  ctx: ParseContext,
  result: IngestResult,
): (Partial<ContentItem> & { raw?: unknown }) | null {
  try {
    const out = parser(raw, ctx) as (Partial<ContentItem> & { raw?: unknown }) | null;
    if (out === null) {
      result.skipped += 1;
      return null;
    }
    return out;
  } catch (e) {
    result.skipped += 1;
    result.warnings.push(`${locate(ctx)}: ${describe(e)}`);
    return null;
  }
}

/** Fill runner bookkeeping around the parser's partial into a candidate item. */
function buildItem(
  out: Partial<ContentItem> & { raw?: unknown },
  source: IngestSource,
  nowIso: string,
): (ContentItem & { raw?: unknown }) | null {
  const id = out.id ?? out.external_id;
  if (id === undefined || id.trim() === "") {
    return null;
  }
  const status: ContentStatus = out.status ?? "idea";
  const timestamps = {
    created_at: out.timestamps?.created_at ?? nowIso,
    updated_at: nowIso,
  } as ContentItem["timestamps"];
  if (status === "published") {
    timestamps.published_at = out.timestamps?.published_at ?? nowIso;
  } else if (out.timestamps?.published_at !== undefined) {
    timestamps.published_at = out.timestamps.published_at;
  }
  const item: ContentItem & { raw?: unknown } = {
    id,
    source_kind: source.kind,
    status,
    platform_refs: out.platform_refs ?? [],
    published_urls: out.published_urls ?? [],
    objective: out.objective ?? DEFAULT_INGEST_OBJECTIVE,
    timestamps,
  };
  if (out.external_id !== undefined) {
    item.external_id = out.external_id;
  }
  if (out.raw !== undefined) {
    item.raw = out.raw;
  }
  return item;
}

/**
 * fetch -> transitionStatus -> upsert. On a re-encountered upstream id
 * the stored item is merged with the fresh parser output; the status
 * move is validated through transitionStatus so Illegal moves (stale
 * snapshot regressions, terminal escapes) surface as warnings.
 */
function upsertMerged(
  store: StateStore,
  incoming: ContentItem & { raw?: unknown },
  now: Date,
): void {
  let existing: ContentItem | null = null;
  try {
    existing = store.getById(incoming.id);
  } catch (e) {
    // NotFound is the expected "first sighting" path; anything else is
    // a store failure surfaced to the caller's warn+skip.
    if (!isNotFound(e)) {
      throw e;
    }
  }

  if (existing === null) {
    store.upsertContentItem(incoming);
    return;
  }

  if (existing.status !== incoming.status) {
    // Legality check + semantic timestamps (published_at on publish).
    transitionStatus(existing, incoming.status, now);
  }

  const merged: ContentItem & { raw?: unknown } = {
    ...existing,
    source_kind: incoming.source_kind,
    external_id: incoming.external_id ?? existing.external_id,
    status: incoming.status,
    platform_refs: union(existing.platform_refs, incoming.platform_refs),
    published_urls: union(existing.published_urls, incoming.published_urls),
    objective: incoming.objective ?? existing.objective,
    timestamps: {
      created_at: existing.timestamps.created_at,
      updated_at: now.toISOString(),
      published_at:
        incoming.status === "published"
          ? (incoming.timestamps.published_at ?? existing.timestamps.published_at)
          : existing.timestamps.published_at,
    },
  };
  const upstream = incoming.raw ?? (existing as { raw?: unknown }).raw;
  if (upstream !== undefined) {
    merged.raw = upstream;
  }
  store.upsertContentItem(merged);
}

function isNotFound(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: unknown }).code === "NOT_FOUND" &&
    (e as { entity?: unknown }).entity === "ContentItem"
  );
}

function describe(e: unknown): string {
  if (e instanceof InvalidTransition) {
    return `invalid transition ${e.from} -> ${e.to}`;
  }
  return causeMessage(e);
}
