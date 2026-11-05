import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INGEST_UNMOUNTED, isServiceError, type ServiceError } from "../errors.js";
import {
  checkMountHealth,
  DEFAULT_INGEST_SOURCES,
  EXPECTED_SUBDIRS,
  type IngestResult,
  type IngestSource,
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
    const byName: IngestSource = { kind: "drafts", path: "state/drafts", parser: "drafts" };
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
      source: "queue",
      file: "queue/publish/1.json",
      line: 3,
    });
    expect(partial.external_id).toBe("ext-42");
    expect(partial.source_kind).toBe("n8n");
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
