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
import { join } from "node:path";
import { causeMessage, INGEST_UNMOUNTED, isServiceError, wellKnown } from "../errors.js";
import type { ContentItem } from "../model/contract.js";

/** Kinds of n8n-state sources the ingester understands. */
export type IngestSourceKind = "drafts" | "queue" | "publish_log";

export const INGEST_SOURCE_KINDS: readonly IngestSourceKind[] = ["drafts", "queue", "publish_log"];

/** Location context handed to a {@link SourceParser} for error reporting. */
export interface ParseContext {
  /** Which source kind produced this raw record. */
  source: IngestSourceKind;
  /** File being parsed, relative to the mount root. */
  file?: string;
  /** 1-based line number for line-oriented sources. */
  line?: number;
}

/**
 * Maps one raw record (a whole file or a single line, depending on the
 * source kind) into a partial {@link ContentItem}. The ingester fills in
 * pipeline bookkeeping fields (id, status defaults, timestamps) around
 * whatever the parser yields; a parser returning a sparse partial is
 * legal, an unparseable record contributes to `skipped`/`warnings` of
 * {@link IngestResult}, not to a crash.
 */
export type SourceParser = (raw: string, ctx?: ParseContext) => Partial<ContentItem>;

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
   * Parser ref: either a registry name the ingester resolves to a
   * concrete parser, or a direct {@link SourceParser} function.
   */
  parser: string | SourceParser;
}

/**
 * The three canonical sources of the n8n-state mount. Their `path`s are
 * also exactly the subdirectories {@link checkMountHealth} requires to
 * exist - see {@link EXPECTED_SUBDIRS}.
 */
export const DEFAULT_INGEST_SOURCES: readonly IngestSource[] = [
  { kind: "drafts", path: "state/drafts", parser: "drafts" },
  { kind: "queue", path: "queue/publish", parser: "queue" },
  { kind: "publish_log", path: "logs", parser: "publish_log" },
];

/** Subdirectories a healthy mount root must contain (derived from the sources). */
export const EXPECTED_SUBDIRS: readonly string[] = DEFAULT_INGEST_SOURCES.map((s) => s.path);

/** Successful result of {@link checkMountHealth}. */
export interface MountHealth {
  ok: true;
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
 */
export async function checkMountHealth(root: string): Promise<MountHealth> {
  const rootStat = await stat(root).catch((e: unknown) => {
    throw wellKnown(INGEST_UNMOUNTED, `mount root is not accessible: ${root} (${causeMessage(e)})`);
  });
  if (!rootStat.isDirectory()) {
    throw wellKnown(INGEST_UNMOUNTED, `mount root is not a directory: ${root}`);
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
