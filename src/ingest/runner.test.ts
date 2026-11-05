import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isServiceError } from "../errors.js";
import type { ContentItem } from "../model/contract.js";
import { NotFound } from "../store/contract.js";
import { SqliteStore } from "../store/sqlite.js";
import { EXPECTED_SUBDIRS } from "./contract.js";
import { n8nItemId } from "./parsers.js";
import { ingestAll } from "./runner.js";

const tmpRoots: string[] = [];
const stores: SqliteStore[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pr-manager-ingest-run-"));
  tmpRoots.push(root);
  for (const sub of EXPECTED_SUBDIRS) {
    await mkdir(join(root, sub), { recursive: true });
  }
  return root;
}

function memStore(): SqliteStore {
  const s = new SqliteStore(":memory:");
  s.migrate();
  stores.push(s);
  return s;
}

afterEach(async () => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
  while (tmpRoots.length > 0) {
    const d = tmpRoots.pop();
    if (d !== undefined) {
      await rm(d, { recursive: true, force: true });
    }
  }
});

async function put(root: string, rel: string, body: string): Promise<void> {
  await mkdir(join(root, rel, ".."), { recursive: true });
  await writeFile(join(root, rel), body);
}

/* Real upstream fixture shapes (bodies shortened). */

const draft = (id: string, status: string, platform = "vk") =>
  JSON.stringify({
    id,
    platform,
    topic: "topic line",
    text: "short body",
    image: "",
    status,
    created_at: "2026-10-24T17:01:55.064Z",
    message_id: "4",
  });

const queueEntry = (id: string, platform = "vk") =>
  JSON.stringify({
    id,
    platform,
    text: "short body",
    image: "",
    media: [],
    test: false,
    approved_at: "2026-10-28T05:40:35.998Z",
  });

const logLine = (over: Record<string, unknown>) => JSON.stringify(over);

describe("ingestAll - the 5 roadmap GWTs", () => {
  it("GWT-1: draft file -> ContentItem with mapped status and platform", async () => {
    const root = await makeRoot();
    const store = memStore();
    await put(root, "state/drafts/d1.json", draft("d1", "draft"));

    const res = await ingestAll(store, root);
    expect(res).toEqual({ items: 1, skipped: 0, warnings: [] });

    const item = store.getById(n8nItemId("d1"));
    expect(item.status).toBe("draft");
    expect(item.platform_refs).toEqual(["vk"]);
    expect(item.source_kind).toBe("drafts");
    expect(item.external_id).toBe("d1");
    expect(item.objective).toBe("proof"); // deterministic default
    expect(item.timestamps.created_at).toBe("2026-10-24T17:01:55.064Z");
  });

  it("draft status mapping: pending->moderation, approved->approved, rejected->rejected", async () => {
    const root = await makeRoot();
    const store = memStore();
    await put(root, "state/drafts/p.json", draft("p", "pending"));
    await put(root, "state/drafts/a.json", draft("a", "approved", "linkedin"));
    await put(root, "state/drafts/r.json", draft("r", "rejected"));

    const res = await ingestAll(store, root);
    expect(res.items).toBe(3);
    expect(store.getById(n8nItemId("p")).status).toBe("moderation");
    expect(store.getById(n8nItemId("a")).status).toBe("approved");
    expect(store.getById(n8nItemId("a")).platform_refs).toEqual(["linkedin"]);
    expect(store.getById(n8nItemId("r")).status).toBe("rejected");
  });

  it("GWT-2: publish.jsonl published line -> published item with published_urls", async () => {
    const root = await makeRoot();
    const store = memStore();
    await put(
      root,
      "logs/publish.jsonl",
      logLine({
        ts: "2026-10-26T19:09:02.837Z",
        id: "pub1",
        platform: "vk",
        via: "vk api wall.post 29642349_300 verified +deleted",
        status: "published",
      }),
    );

    const res = await ingestAll(store, root);
    expect(res.items).toBe(1);

    const item = store.getById(n8nItemId("pub1"));
    expect(item.status).toBe("published");
    expect(item.published_urls).toEqual(["https://vk.com/wall29642349_300"]);
    expect(item.timestamps.published_at).toBe("2026-10-26T19:09:02.837Z");
    expect(store.pendingAudit().map((i) => i.id)).toEqual([n8nItemId("pub1")]);
  });

  it("GWT-3: re-ingesting the same files produces no duplicates", async () => {
    const root = await makeRoot();
    const store = memStore();
    await put(root, "state/drafts/d1.json", draft("d1", "approved"));
    await put(root, "queue/publish/done/d1.json", queueEntry("d1"));
    await put(
      root,
      "logs/publish.jsonl",
      logLine({
        ts: "2026-10-28T06:00:00.000Z",
        id: "d1",
        platform: "vk",
        via: "vk api wall.post 29642349_300",
        status: "published",
      }),
    );

    const first = await ingestAll(store, root);
    // drafts(approved) -> queue done(published) -> log(published): one item travels
    const second = await ingestAll(store, root);

    const published = store.getByStatus("published");
    expect(published).toHaveLength(1);
    const item = store.getById(n8nItemId("d1"));
    expect(item.status).toBe("published");
    expect(item.published_urls).toEqual(["https://vk.com/wall29642349_300"]);

    const count = store.db.prepare("SELECT COUNT(*) AS n FROM content_items").get() as {
      n: number;
    };
    expect(count.n).toBe(1);

    // first pass: 3 records upsert the one item; second pass: the stale
    // approved draft is a regression -> warn+skip, queue/log are no-ops.
    expect(first.items).toBe(3);
    expect(second.items).toBe(2);
    expect(second.skipped).toBe(1);
    expect(second.warnings.some((w) => w.includes("invalid transition"))).toBe(true);
  });

  it("GWT-4: a corrupt JSON line/file is skipped + warned, the pass survives", async () => {
    const root = await makeRoot();
    const store = memStore();
    await put(root, "state/drafts/good.json", draft("good", "pending"));
    await put(
      root,
      "logs/publish.jsonl",
      [
        '{"ts":"2026-10-26T19:09:02.837Z","id":"p1","platform":"vk","status":"published","via":"vk api wall.post 1_2"}',
        "{not json at all",
        '{"ts":"2026-10-26T20:00:00.000Z","id":"p2","platform":"vk","status":"failed","error":"x"}',
      ].join("\n"),
    );

    const res = await ingestAll(store, root);
    expect(res.items).toBe(3); // draft + published + failed
    expect(res.skipped).toBe(1);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("logs/publish.jsonl:2");

    expect(store.getById(n8nItemId("p1")).status).toBe("published");
    expect(store.getById(n8nItemId("p2")).status).toBe("failed");
  });

  it("GWT-5: an empty mount root fail-closes with ingest_unmounted", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-manager-ingest-empty-"));
    tmpRoots.push(root); // exists but no subdirectories
    const store = memStore();

    await expect(ingestAll(store, root)).rejects.toSatisfy(
      (e: unknown) => isServiceError(e) && e.code === "ingest_unmounted",
    );
  });
});

describe("ingestAll - item travel across sources", () => {
  it("one upstream id is ONE ContentItem moving moderation -> published via queue + log", async () => {
    const root = await makeRoot();
    const store = memStore();
    await put(root, "state/drafts/x.json", draft("x", "pending"));
    await put(root, "queue/publish/done/x.json", queueEntry("x"));
    await put(
      root,
      "logs/publish.jsonl",
      logLine({
        ts: "2026-10-28T06:00:00.000Z",
        id: "x",
        platform: "vk",
        via: "vk api wall.post 29642349_301",
        status: "published",
      }),
    );

    const res = await ingestAll(store, root);
    expect(res.items).toBe(3);
    const count = store.db.prepare("SELECT COUNT(*) AS n FROM content_items").get() as {
      n: number;
    };
    expect(count.n).toBe(1);

    const item = store.getById(n8nItemId("x"));
    expect(item.status).toBe("published");
    expect(item.source_kind).toBe("publish_log"); // last writer wins
    expect(item.published_urls).toEqual(["https://vk.com/wall29642349_301"]);
    // upstream creation time survives the journey
    expect(item.timestamps.created_at).toBe("2026-10-24T17:01:55.064Z");
  });
});

describe("ingestAll - queue directory status mapping", () => {
  it("maps subdirectories: root/processing->queued, done->published, failed->failed, skipped->rejected", async () => {
    const root = await makeRoot();
    const store = memStore();
    await put(root, "queue/publish/root1.json", queueEntry("root1"));
    await put(root, "queue/publish/processing/proc1.json", queueEntry("proc1"));
    await put(root, "queue/publish/done/done1.json", queueEntry("done1"));
    await put(root, "queue/publish/failed/fail1.json", queueEntry("fail1"));
    await put(root, "queue/publish/skipped/skip1.json", queueEntry("skip1"));

    const res = await ingestAll(store, root);
    expect(res.items).toBe(5);
    expect(store.getById(n8nItemId("root1")).status).toBe("queued");
    expect(store.getById(n8nItemId("proc1")).status).toBe("queued");
    expect(store.getById(n8nItemId("done1")).status).toBe("published");
    expect(store.getById(n8nItemId("fail1")).status).toBe("failed");
    expect(store.getById(n8nItemId("skip1")).status).toBe("rejected");
  });
});

describe("ingestAll - publish_log statuses", () => {
  it("failed keeps maybe_live in raw; operational statuses are skipped", async () => {
    const root = await makeRoot();
    const store = memStore();
    await put(
      root,
      "logs/publish.jsonl",
      [
        logLine({
          ts: "2026-10-28T08:53:50.812Z",
          id: "f1",
          platform: "vk",
          status: "failed",
          maybe_live: true,
          external_id: null,
          error: "vk wall.post: token expired",
        }),
        logLine({
          ts: "2026-10-28T03:40:56.433Z",
          id: "f1",
          platform: "vk",
          status: "retry-requeued",
          note: "retry: token service down",
          retry: "1",
        }),
        logLine({
          ts: "2026-10-27T11:05:01.839Z",
          id: "tp1",
          platform: "vk",
          via: "vk api wall.post 29642349_301 verified +deleted",
          status: "test-published-deleted",
        }),
        logLine({
          ts: "2026-10-26T19:10:56.111Z",
          id: "sk1",
          platform: "facebook",
          status: "skipped",
        }),
        logLine({
          ts: "2026-10-28T12:20:56.146Z",
          id: "st1",
          platform: "vk",
          status: "stuck-claim-recovered",
        }),
      ].join("\n"),
    );

    const res = await ingestAll(store, root);
    expect(res.items).toBe(1);
    expect(res.skipped).toBe(4);
    expect(res.warnings).toEqual([]);

    const item = store.getById(n8nItemId("f1")) as ContentItem & { raw?: unknown };
    expect(item.status).toBe("failed");
    expect((item.raw as Record<string, unknown>).maybe_live).toBe(true);
    expect(() => store.getById(n8nItemId("tp1"))).toThrow(NotFound);
  });

  it("derives upstream id from the `file` field when `id` is absent", async () => {
    const root = await makeRoot();
    const store = memStore();
    await put(
      root,
      "logs/publish.jsonl",
      logLine({
        ts: "2026-10-28T08:21:02.378Z",
        file: "f-noid-1793.json",
        status: "failed",
        error: "bad json",
      }),
    );

    const res = await ingestAll(store, root);
    expect(res.items).toBe(1);
    expect(store.getById(n8nItemId("f-noid-1793")).status).toBe("failed");
  });
});

describe("ingestAll - corrupt records", () => {
  it("a JSON 'null' file body is skipped + warned, other files still ingest", async () => {
    const root = await makeRoot();
    const store = memStore();
    await put(root, "queue/publish/failed/nullbody.json", "null");
    await put(root, "queue/publish/done/ok.json", queueEntry("ok"));

    const res = await ingestAll(store, root);
    expect(res.items).toBe(1);
    expect(res.skipped).toBe(1);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("queue/publish/failed/nullbody.json");
    expect(store.getById(n8nItemId("ok")).status).toBe("published");
  });

  it("an unknown platform fails loudly as warning + skip", async () => {
    const root = await makeRoot();
    const store = memStore();
    await put(root, "state/drafts/u.json", draft("u", "pending", "unknown"));

    const res = await ingestAll(store, root);
    expect(res.items).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.warnings[0]).toContain("unknown platform");
  });
});
