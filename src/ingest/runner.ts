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
 * - `objective`: parsers omit it when it is not derivable; a NEW item
 *   gets the deterministic default "proof", an EXISTING item keeps
 *   whatever objective it already has (a curated value is never
 *   clobbered by re-ingest). TODO(item_07): derive from BrandCharter
 *   once it lands.
 * - `timestamps.updated_at`: ingest time; `created_at` keeps the
 *   upstream creation time when the parser supplies one.
 *
 * Merge semantics on re-encounter (idempotent re-ingest): same-status
 * writes are no-op updates; forward moves travel through
 * transitionStatus (published_at is set once, preferring the upstream
 * timestamp when the parser provides one); `platform_refs` and
 * `published_urls` merge as set-union so a later source enriches
 * rather than clobbers earlier data. When the merged row deep-equals
 * the stored one the write is skipped entirely - a no-op re-ingest
 * does not churn `updated_at`. A parse `null` counts as skipped;
 * a throw counts as skipped + warning. Neither kills the pass.
 *
 * Publish-log attempt telemetry: `failed` / `retry-requeued` /
 * `stuck-claim-recovered` lines are PER-ATTEMPT events (upstream
 * retries; a failed line can be followed by retry-requeued and an
 * eventual published on the same id). The parser returns null for
 * them so they never drive a status transition; the runner re-reads
 * such lines and records an IngestResult.warnings entry carrying
 * id + status + maybe_live for operators. Terminal `failed` comes
 * only from queue/publish/failed/*.json files.
 *
 * `IngestResult.warnings` is capped at {@link WARNINGS_CAP} entries;
 * the pass keeps counting every warning in
 * {@link IngestRunResult.warnings_total}.
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
import { type IngestedContentItem, type IngestPartial, PARSER_REGISTRY } from "./parsers.js";

export interface IngestOptions {
  /** Extra mount verification passed through to checkMountHealth. */
  mount?: MountHealthOptions;
  /** Clock injection for tests; defaults to wall time. */
  now?: () => Date;
}

/** Default objective for upstream records that carry no pillar tag (applied at creation only). */
export const DEFAULT_INGEST_OBJECTIVE: ContentItem["objective"] = "proof";

/**
 * Hard cap on the `warnings` array of one ingest pass: a pathological
 * mount (e.g. a corrupt JSONL stream) must not grow memory without
 * bound. Every warning is still counted in
 * {@link IngestRunResult.warnings_total}.
 */
export const WARNINGS_CAP = 200;

/**
 * Aggregate outcome of {@link ingestAll}: the contract
 * {@link IngestResult} plus `warnings_total`, the number of warnings
 * EMITTED this pass - `warnings` holds at most {@link WARNINGS_CAP}
 * entries, so `warnings_total` is the field to monitor when the two
 * diverge. (Non-contract extension of IngestResult: a superset, so the
 * value still satisfies the contract interface.)
 */
export interface IngestRunResult extends IngestResult {
  /** Total warnings emitted this pass (>= warnings.length). */
  warnings_total: number;
}

/**
 * Item shape built by the runner around a parser's partial: every
 * ContentItem field except `objective`, which stays optional so the
 * creation-vs-merge decision (default "proof" vs keep curated) can be
 * made against the stored item.
 */
type IngestCandidate = Omit<IngestedContentItem, "objective"> & {
  objective?: IngestedContentItem["objective"];
};

/** Append `msg` to the result warnings, honoring {@link WARNINGS_CAP}. */
function warn(result: IngestRunResult, msg: string): void {
  result.warnings_total += 1;
  if (result.warnings.length < WARNINGS_CAP) {
    result.warnings.push(msg);
  }
}

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

interface ScanResult {
  /** Regular files matching `ext`, sorted. */
  files: string[];
  /**
   * Symlinked entries skipped by the scan: a Dirent's isFile()/isDirectory()
   * do not follow links, so a symlinked *.json / *.jsonl / subdirectory
   * would otherwise vanish without a trace. Callers count each as a
   * skipped record + warning.
   */
  symlinks: string[];
}

async function listFiles(dir: string, ext: string): Promise<ScanResult> {
  const files: string[] = [];
  const symlinks: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) {
      symlinks.push(p);
    } else if (e.isDirectory()) {
      const sub = await listFiles(p, ext);
      files.push(...sub.files);
      symlinks.push(...sub.symlinks);
    } else if (e.isFile() && e.name.endsWith(ext)) {
      files.push(p);
    }
  }
  files.sort();
  return { files, symlinks };
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

/**
 * Slice a source directory into per-record inputs per INGEST_GRANULARITY.
 * Skipped symlinks found while scanning are counted + warned into
 * `result` (a symlinked file or tree must not vanish silently).
 */
async function* recordsOf(
  source: IngestSource,
  root: string,
  result: IngestRunResult,
): AsyncGenerator<RawRecord> {
  const dir = join(root, source.path);
  const granularity = INGEST_GRANULARITY[source.kind];
  const ext = granularity === "file" ? ".json" : ".jsonl";
  const scan = await listFiles(dir, ext);
  for (const link of scan.symlinks) {
    const rel = relative(root, link).split(sep).join("/");
    result.skipped += 1;
    warn(result, `${rel}: skipped symlink (not followed)`);
  }
  if (granularity === "file") {
    for (const file of scan.files) {
      yield {
        raw: await readFile(file, "utf8"),
        ctx: { kind: source.kind, path: relative(root, file).split(sep).join("/") },
      };
    }
    return;
  }
  // line granularity: every line of every matching *.jsonl file is a record
  const filter = LINE_FILE_FILTER[source.kind] ?? /\.jsonl$/;
  for (const file of scan.files) {
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
): Promise<IngestRunResult> {
  await checkMountHealth(root, opts.mount);

  const now = opts.now?.() ?? new Date();
  const nowIso = now.toISOString();
  const result: IngestRunResult = { items: 0, skipped: 0, warnings: [], warnings_total: 0 };

  for (const source of sources) {
    const parser = resolveParser(source);
    for await (const { raw, ctx } of recordsOf(source, root, result)) {
      const outcome = parseRecord(parser, raw, ctx, result);
      if (outcome === null) {
        continue;
      }
      const item = buildItem(outcome, source, nowIso);
      if (item === null) {
        result.skipped += 1;
        warn(result, `${locate(ctx)}: parser yielded no identity (id/external_id)`);
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
        warn(result, `${locate(ctx)}: ${describe(e)}`);
      }
    }
  }
  return result;
}

/**
 * Publish-log statuses that are PER-ATTEMPT telemetry, not pipeline
 * transitions: upstream retries failed items, so a `failed` line on an
 * id may be followed by `retry-requeued` and an eventual `published`.
 * The parser skips them; the runner surfaces each as a warning so a
 * failed attempt (and especially a `maybe_live` one) is visible to
 * operators. Terminal `failed` is driven by queue/publish/failed/*.json.
 */
const ATTEMPT_TELEMETRY: ReadonlySet<string> = new Set([
  "failed",
  "retry-requeued",
  "stuck-claim-recovered",
]);

/**
 * When a publish_log line is parser-skipped, re-read it: if it is one
 * of the {@link ATTEMPT_TELEMETRY} statuses, record a warning carrying
 * the upstream id (`id`, falling back to the `file` basename like the
 * parser), the status and the `maybe_live` flag when present.
 */
function recordAttemptTelemetry(raw: string, ctx: ParseContext, result: IngestRunResult): void {
  let rec: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return;
    }
    rec = parsed as Record<string, unknown>;
  } catch {
    return; // corrupt lines already produce a parse warning; nothing more to extract
  }
  const status = rec.status;
  if (typeof status !== "string" || !ATTEMPT_TELEMETRY.has(status)) {
    return;
  }
  const id =
    typeof rec.id === "string" && rec.id.trim() !== ""
      ? rec.id
      : typeof rec.file === "string" && rec.file.trim() !== ""
        ? rec.file.replace(/\.json$/i, "")
        : "?";
  const maybeLive = "maybe_live" in rec ? ` maybe_live=${JSON.stringify(rec.maybe_live)}` : "";
  warn(result, `${locate(ctx)}: publish attempt ${status} (id=${id}${maybeLive})`);
}

/**
 * Run the parser over one record; null/throw both mean "skipped".
 * A skipped publish_log record may still be attempt telemetry - see
 * {@link recordAttemptTelemetry}.
 */
function parseRecord(
  parser: SourceParser,
  raw: string,
  ctx: ParseContext,
  result: IngestRunResult,
): IngestPartial | null {
  try {
    const out = parser(raw, ctx) as IngestPartial | null;
    if (out === null) {
      result.skipped += 1;
      if (ctx.kind === "publish_log") {
        recordAttemptTelemetry(raw, ctx, result);
      }
      return null;
    }
    return out;
  } catch (e) {
    result.skipped += 1;
    warn(result, `${locate(ctx)}: ${describe(e)}`);
    return null;
  }
}

/**
 * Fill runner bookkeeping around the parser's partial into a candidate
 * item. `objective` is left absent unless the parser derived one - the
 * upsert decides between the creation default and the stored value.
 */
function buildItem(
  out: IngestPartial,
  source: IngestSource,
  nowIso: string,
): IngestCandidate | null {
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
  const item: IngestCandidate = {
    id,
    source_kind: source.kind,
    status,
    platform_refs: out.platform_refs ?? [],
    published_urls: out.published_urls ?? [],
    timestamps,
  };
  if (out.external_id !== undefined) {
    item.external_id = out.external_id;
  }
  if (out.objective !== undefined) {
    item.objective = out.objective;
  }
  if (out.raw !== undefined) {
    item.raw = out.raw;
  }
  return item;
}

/**
 * Semantic equality of two items, ignoring `timestamps.updated_at`
 * (the ingest-pass stamp): used to skip writes a re-ingest would
 * repeat verbatim so a no-op re-ingest is truly silent.
 */
function sameItem(a: IngestedContentItem, b: IngestedContentItem): boolean {
  return (
    a.id === b.id &&
    a.source_kind === b.source_kind &&
    (a.external_id ?? null) === (b.external_id ?? null) &&
    a.status === b.status &&
    a.objective === b.objective &&
    JSON.stringify(a.platform_refs) === JSON.stringify(b.platform_refs) &&
    JSON.stringify(a.published_urls) === JSON.stringify(b.published_urls) &&
    a.timestamps.created_at === b.timestamps.created_at &&
    (a.timestamps.published_at ?? null) === (b.timestamps.published_at ?? null) &&
    (a.raw ?? null) === (b.raw ?? null)
  );
}

/**
 * fetch -> transitionStatus -> upsert. On a re-encountered upstream id
 * the stored item is merged with the fresh parser output; the status
 * move is validated through transitionStatus so Illegal moves (stale
 * snapshot regressions, terminal escapes) surface as warnings.
 *
 * `objective` is applied only when the incoming record carries one:
 * a new item falls back to {@link DEFAULT_INGEST_OBJECTIVE} at
 * creation, an existing item keeps its (possibly curated) objective.
 * When the merged row deep-equals the stored one the write is skipped -
 * a no-op re-ingest must not churn `updated_at`.
 */
function upsertMerged(store: StateStore, incoming: IngestCandidate, now: Date): void {
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
    store.upsertContentItem({
      ...incoming,
      objective: incoming.objective ?? DEFAULT_INGEST_OBJECTIVE,
    });
    return;
  }

  if (existing.status !== incoming.status) {
    // Legality check + semantic timestamps (published_at on publish).
    transitionStatus(existing, incoming.status, now);
  }

  const merged: IngestedContentItem = {
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
  const upstream = incoming.raw ?? (existing as IngestedContentItem).raw;
  if (upstream !== undefined) {
    merged.raw = upstream;
  }
  if (sameItem(existing as IngestedContentItem, merged)) {
    return; // truly silent no-op: nothing but updated_at would change
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
