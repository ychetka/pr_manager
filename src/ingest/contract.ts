/**
 * Ingest-source contract (roadmap item_03).
 *
 * Describes how the mounted n8n-state volume is laid out and verified.
 * The actual ingester (item_04) walks {@link DEFAULT_INGEST_SOURCES}
 * under a mount root that has passed {@link checkMountHealth}, runs each
 * source's parser over its raw records and upserts the resulting
 * ContentItems through the StateStore contract.
 */

import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { causeMessage, INGEST_UNMOUNTED, isServiceError, wellKnown } from "../errors.js";
import type { ContentItem } from "../model/contract.js";

/** Kinds of n8n-state sources the ingester understands. */
export type IngestSourceKind = "drafts" | "queue" | "publish_log";

export const INGEST_SOURCE_KINDS: readonly IngestSourceKind[] = ["drafts", "queue", "publish_log"];

/** Location context handed to a {@link SourceParser} for error reporting. */
export interface ParseContext {
  /** Which source kind produced this raw record. */
  kind: IngestSourceKind;
  /** File being parsed, relative to the mount root. */
  path: string;
  /** 1-based line number within `path`, set for line-granular sources. */
  line_no?: number;
}

/**
 * What a {@link SourceParser} returns for one logical record: a partial
 * {@link ContentItem}, or `null` for "unparseable - count as skipped".
 */
export type ParseOutcome = Partial<ContentItem> | null;

/**
 * How the ingester slices a source's raw input into logical records:
 * "file" = one parser invocation per file body, "line" = one per JSONL
 * line. See {@link INGEST_GRANULARITY}.
 */
export type IngestGranularity = "file" | "line";

/**
 * Per-kind record granularity: the parser is invoked PER LOGICAL
 * RECORD - one JSONL line for publish_log, one whole file body for
 * drafts/queue.
 */
export const INGEST_GRANULARITY: Readonly<Record<IngestSourceKind, IngestGranularity>> = {
  drafts: "file",
  queue: "file",
  publish_log: "line",
};

/**
 * Maps ONE logical record (per {@link INGEST_GRANULARITY}: a single
 * JSONL line for publish_log, a whole file body for drafts/queue) into
 * a {@link ParseOutcome}.
 *
 * Boundary contract - a parser must never crash an ingest pass:
 * - returning `null` means "this record is unparseable, count it as
 *   `skipped`" of {@link IngestResult};
 * - THROWING means the same thing, louder: the ingester appends a
 *   `warnings` entry (with the {@link ParseContext} location) AND
 *   counts the record as `skipped`.
 *
 * The ingester fills in pipeline bookkeeping fields (id, status
 * defaults, timestamps) around whatever the parser yields; a sparse
 * partial is legal.
 */
export type SourceParser = (raw: string, ctx: ParseContext) => ParseOutcome;

/** Registry names of the built-in parsers for the canonical n8n sources. */
export type ParserName = "n8n-drafts" | "n8n-queue" | "n8n-publish-log";

export const PARSER_NAMES: readonly ParserName[] = ["n8n-drafts", "n8n-queue", "n8n-publish-log"];

/**
 * One n8n-state source under the mounted volume.
 */
export interface IngestSource {
  /** What kind of upstream state this source feeds into the pipeline. */
  kind: IngestSourceKind;
  /**
   * Directory path relative to the mount root (e.g. "state/drafts").
   * The ingester resolves it against the mount; it is never absolute.
   */
  path: string;
  /**
   * Parser ref: either a {@link ParserName} the ingester resolves to a
   * concrete parser, or a direct {@link SourceParser} function.
   */
  parser: ParserName | SourceParser;
}

/**
 * The three canonical sources of the n8n-state mount. Their `path`s are
 * also exactly the subdirectories {@link checkMountHealth} requires to
 * exist - see {@link EXPECTED_SUBDIRS}.
 */
export const DEFAULT_INGEST_SOURCES: readonly IngestSource[] = [
  { kind: "drafts", path: "state/drafts", parser: "n8n-drafts" },
  { kind: "queue", path: "queue/publish", parser: "n8n-queue" },
  { kind: "publish_log", path: "logs", parser: "n8n-publish-log" },
];

/** Subdirectories a healthy mount root must contain (derived from the sources). */
export const EXPECTED_SUBDIRS: readonly string[] = DEFAULT_INGEST_SOURCES.map((s) => s.path);

/** Successful result of {@link checkMountHealth}. */
export interface MountHealth {
  ok: true;
}

/**
 * Options tightening {@link checkMountHealth} beyond the default
 * directory-tree check.
 */
export interface MountHealthOptions {
  /**
   * When true, `root` must be a REAL mount point: the check compares
   * `stat(root).dev` against `stat(dirname(root)).dev` and fails with
   * "ingest_unmounted" when they match - a mounted volume lives on a
   * different device than its parent directory.
   */
  requireMount?: boolean;
  /**
   * Name of a sentinel file (relative to `root`) that MUST exist -
   * e.g. a marker the volume provisioner writes. Missing or
   * not-a-regular-file fails closed with "ingest_unmounted".
   */
  sentinel?: string;
}

/**
 * Verify the mounted n8n-state volume, fail-closed.
 *
 * Healthy means: `root` exists, is a directory, and every
 * {@link EXPECTED_SUBDIRS} subdirectory exists, is a directory and is
 * readable. Anything else - a missing root, a file where the root should
 * be, an empty mount, missing/unreadable subdirectories - throws a
 * ServiceError with code "ingest_unmounted" (subsystem ingest,
 * retryable=false): on a broken or empty mount the ingester must refuse
 * to run rather than silently ingest a partial state.
 *
 * Known limitation of the default (options-less) check: it detects a
 * missing dir tree, not an unmounted volume with leftovers - an
 * unmounted mountpoint that kept its old subdirectories still passes.
 * Use `requireMount`/`sentinel` in production.
 */
export async function checkMountHealth(
  root: string,
  opts: MountHealthOptions = {},
): Promise<MountHealth> {
  const rootStat = await stat(root).catch((e: unknown) => {
    throw wellKnown(INGEST_UNMOUNTED, `mount root is not accessible: ${root} (${causeMessage(e)})`);
  });
  if (!rootStat.isDirectory()) {
    throw wellKnown(INGEST_UNMOUNTED, `mount root is not a directory: ${root}`);
  }

  if (opts.requireMount === true) {
    const parent = dirname(root);
    const parentStat = await stat(parent).catch((e: unknown) => {
      throw wellKnown(
        INGEST_UNMOUNTED,
        `mount parent is not accessible: ${parent} (${causeMessage(e)})`,
      );
    });
    if (parentStat.dev === rootStat.dev) {
      throw wellKnown(
        INGEST_UNMOUNTED,
        `mount root is not a mount point: ${root} (same device as ${parent})`,
      );
    }
  }

  if (opts.sentinel !== undefined) {
    const marker = join(root, opts.sentinel);
    const markerStat = await stat(marker).catch(() => undefined);
    if (markerStat === undefined || !markerStat.isFile()) {
      throw wellKnown(INGEST_UNMOUNTED, `mount sentinel file is missing: ${marker}`);
    }
  }

  for (const sub of EXPECTED_SUBDIRS) {
    const dir = join(root, sub);
    try {
      const subStat = await stat(dir);
      if (!subStat.isDirectory()) {
        throw wellKnown(INGEST_UNMOUNTED, `expected subdirectory is not a directory: ${dir}`);
      }
      await access(dir, constants.R_OK);
    } catch (e) {
      if (isServiceError(e)) {
        throw e;
      }
      throw wellKnown(
        INGEST_UNMOUNTED,
        `expected subdirectory is missing or unreadable: ${dir} (${causeMessage(e)})`,
      );
    }
  }
  return { ok: true };
}

/** Aggregate outcome of one ingest pass over the sources. */
export interface IngestResult {
  /** Records parsed and upserted into the store. */
  items: number;
  /** Records skipped: empty, unparseable or deduplicated upstream. */
  skipped: number;
  /** Non-fatal problems worth surfacing in logs and the digest. */
  warnings: string[];
}
