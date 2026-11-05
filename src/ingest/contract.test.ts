import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INGEST_UNMOUNTED, isServiceError, type ServiceError } from "../errors.js";
import {
  checkMountHealth,
  DEFAULT_INGEST_SOURCES,
  EXPECTED_SUBDIRS,
  INGEST_GRANULARITY,
  type IngestResult,
  type IngestSource,
  PARSER_NAMES,
  type ParseContext,
  type ParseOutcome,
  type ParserName,
  type SourceParser,
} from "./contract.js";

const tmpRoots: string[] = [];

async function makeTmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pr-manager-ingest-"));
  tmpRoots.push(dir);
  return dir;
}

async function makeHealthyRoot(): Promise<string> {
  const root = await makeTmpRoot();
  for (const sub of EXPECTED_SUBDIRS) {
    await mkdir(join(root, sub), { recursive: true });
  }
  return root;
}

/** Await a promise that is expected to reject; returns the thrown value. */
async function catchThrown(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

afterEach(async () => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("checkMountHealth", () => {
  it("fails closed on a missing mount root with ingest_unmounted (non-retryable)", async () => {
    const root = await makeTmpRoot();
    const missing = join(root, "does-not-exist");

    const e = await catchThrown(checkMountHealth(missing));

    expect(isServiceError(e)).toBe(true);
    const err = e as ServiceError;
    expect(err.code).toBe(INGEST_UNMOUNTED);
    expect(err.code).toBe("ingest_unmounted");
    expect(err.subsystem).toBe("ingest");
    expect(err.retryable).toBe(false);
  });

  it("returns {ok:true} on a root with all expected subdirectories", async () => {
    const root = await makeHealthyRoot();

    await expect(checkMountHealth(root)).resolves.toEqual({ ok: true });
  });

  it("fails closed on an existing but empty mount root", async () => {
    const root = await makeTmpRoot(); // exists, but no subdirectories at all

    const e = await catchThrown(checkMountHealth(root));

    expect(isServiceError(e)).toBe(true);
    const err = e as ServiceError;
    expect(err.code).toBe(INGEST_UNMOUNTED);
    expect(err.subsystem).toBe("ingest");
    expect(err.retryable).toBe(false);
  });

  it("fails when only some of the expected subdirectories exist", async () => {
    const root = await makeTmpRoot();
    await mkdir(join(root, EXPECTED_SUBDIRS[0]), { recursive: true });
    await mkdir(join(root, EXPECTED_SUBDIRS[1]), { recursive: true });
    // EXPECTED_SUBDIRS[2] ("logs") intentionally absent

    const e = await catchThrown(checkMountHealth(root));

    expect(isServiceError(e)).toBe(true);
    expect((e as ServiceError).code).toBe(INGEST_UNMOUNTED);
  });

  it("fails when an expected subdirectory is a regular file", async () => {
    const root = await makeTmpRoot();
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(join(root, "state", "drafts"), "not a directory");
    await mkdir(join(root, "queue", "publish"), { recursive: true });
    await mkdir(join(root, "logs"), { recursive: true });

    const e = await catchThrown(checkMountHealth(root));

    expect(isServiceError(e)).toBe(true);
    expect((e as ServiceError).code).toBe(INGEST_UNMOUNTED);
    expect((e as ServiceError).retryable).toBe(false);
  });

  it("fails when the mount root itself is a regular file", async () => {
    const parent = await makeTmpRoot();
    const file = join(parent, "root-file");
    await writeFile(file, "x");

    const e = await catchThrown(checkMountHealth(file));

    expect(isServiceError(e)).toBe(true);
    expect((e as ServiceError).code).toBe(INGEST_UNMOUNTED);
  });

  it("requireMount fails on a plain directory that is not a real mount point", async () => {
    const root = await makeHealthyRoot(); // leftover dir tree, same device as its parent

    const e = await catchThrown(checkMountHealth(root, { requireMount: true }));

    expect(isServiceError(e)).toBe(true);
    const err = e as ServiceError;
    expect(err.code).toBe(INGEST_UNMOUNTED);
    expect(err.subsystem).toBe("ingest");
    expect(err.retryable).toBe(false);
  });

  it("sentinel fails closed when the marker file is absent under root", async () => {
    const root = await makeHealthyRoot(); // tree present, but no sentinel written

    const e = await catchThrown(checkMountHealth(root, { sentinel: ".mounted" }));

    expect(isServiceError(e)).toBe(true);
    const err = e as ServiceError;
    expect(err.code).toBe(INGEST_UNMOUNTED);
    expect(err.subsystem).toBe("ingest");
    expect(err.retryable).toBe(false);
  });

  it("sentinel fails closed when the marker exists but is a directory", async () => {
    const root = await makeHealthyRoot();
    await mkdir(join(root, ".mounted"));

    const e = await catchThrown(checkMountHealth(root, { sentinel: ".mounted" }));

    expect(isServiceError(e)).toBe(true);
    expect((e as ServiceError).code).toBe(INGEST_UNMOUNTED);
  });

  it("sentinel present under root passes", async () => {
    const root = await makeHealthyRoot();
    await writeFile(join(root, ".mounted"), "n8n-state-volume");

    await expect(checkMountHealth(root, { sentinel: ".mounted" })).resolves.toEqual({ ok: true });
  });
});

describe("IngestSource contract", () => {
  it("default sources cover all three kinds in order", () => {
    expect(DEFAULT_INGEST_SOURCES.map((s) => s.kind)).toEqual(["drafts", "queue", "publish_log"]);
  });

  it("expected subdirs are exactly the default source paths", () => {
    expect(EXPECTED_SUBDIRS).toEqual(["state/drafts", "queue/publish", "logs"]);
    for (const source of DEFAULT_INGEST_SOURCES) {
      expect(EXPECTED_SUBDIRS).toContain(source.path);
      expect(source.path.startsWith("/")).toBe(false); // relative under the mount root
    }
  });

  it("a parser ref can be a registry name or a function", () => {
    const byName: IngestSource = { kind: "drafts", path: "state/drafts", parser: "n8n-drafts" };
    const byFn: IngestSource = {
      kind: "queue",
      path: "queue/publish",
      parser: (raw) => ({ source_kind: "n8n", external_id: raw }),
    };

    expect(typeof byName.parser).toBe("string");
    if (typeof byFn.parser !== "function") {
      expect.unreachable();
    }
    const partial = byFn.parser("ext-42", {
      kind: "queue",
      path: "queue/publish/1.json",
      line_no: 3,
    });
    expect(partial?.external_id).toBe("ext-42");
    expect(partial?.source_kind).toBe("n8n");
  });

  it("default sources use only registered parser names", () => {
    for (const source of DEFAULT_INGEST_SOURCES) {
      if (typeof source.parser !== "string") {
        expect.unreachable();
      }
      const name: ParserName = source.parser;
      expect(PARSER_NAMES).toContain(name);
    }
    expect(PARSER_NAMES).toEqual(["n8n-drafts", "n8n-queue", "n8n-publish-log"]);
  });

  it("INGEST_GRANULARITY fixes per-kind record granularity: files, JSONL for publish_log", () => {
    expect(INGEST_GRANULARITY).toEqual({ drafts: "file", queue: "file", publish_log: "line" });
  });
});

describe("SourceParser boundary", () => {
  const ctx: ParseContext = { kind: "publish_log", path: "logs/publish.jsonl", line_no: 7 };

  it("returning null means 'unparseable, count as skipped'", () => {
    const parser: SourceParser = () => null;

    const outcome: ParseOutcome = parser("garbage line", ctx);

    expect(outcome).toBeNull();
  });

  it("returning a sparse partial is a legal ParseOutcome", () => {
    const parser: SourceParser = (raw) => ({ external_id: raw });

    const outcome = parser("ext-1", { kind: "drafts", path: "state/drafts/1.json" });

    expect(outcome?.external_id).toBe("ext-1");
  });

  it("a THROW propagates to the ingester, which turns it into a warning + skipped", () => {
    const parser: SourceParser = () => {
      throw new Error("bad record");
    };

    expect(() => parser("garbage line", ctx)).toThrow("bad record");
  });

  it("IngestResult carries items, skipped and warnings", () => {
    const result: IngestResult = {
      items: 3,
      skipped: 1,
      warnings: ["line 7 of state/drafts/2.json unparsed"],
    };

    expect(result.items).toBe(3);
    expect(result.skipped).toBe(1);
    expect(result.warnings).toHaveLength(1);
  });
});
