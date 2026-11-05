import { mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerCallbackQuery,
  cadenceAwareFetch,
  handleTelegramUpdate,
  Scheduler,
  type StepName,
} from "./scheduler.js";
import { app, attachScheduler } from "./server.js";
import { SqliteStore } from "./store/sqlite.js";

const NOOP_LOG = () => {};

function memStore(): SqliteStore {
  const store = new SqliteStore(":memory:");
  store.migrate();
  return store;
}

function quietSteps(calls: Record<StepName, number>) {
  return {
    ingest: async () => {
      calls.ingest += 1;
    },
    metrics: async () => {
      calls.metrics += 1;
    },
    digest: async () => {
      calls.digest += 1;
    },
  };
}

describe("Scheduler ticks", () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = memStore();
  });

  it("GWT-1: a successful ingest tick updates health().ingest.last_success", async () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    const sched = new Scheduler(
      { ingest: 0, metrics: 0, digest: 0 },
      { store, now: () => now, log: NOOP_LOG, steps: { ingest: async () => ({ items: 3 }) } },
    );

    const res = await sched.tick("ingest");
    expect(res).toMatchObject({ ok: true, step: "ingest", result: { items: 3 } });

    const health = sched.health();
    expect(health.ingest).toEqual({
      last_success: now.toISOString(),
      last_error: null,
    });
    // Other steps are untouched by an ingest tick.
    expect(health.metrics).toEqual({ last_success: null, last_error: null });
    expect(health.digest).toEqual({ last_success: null, last_error: null });
  });

  it("GWT-2: a failing metrics tick does not stop or delay the digest tick", async () => {
    let digestRuns = 0;
    const sched = new Scheduler(
      {},
      {
        store,
        now: () => new Date("2026-01-02T10:00:00.000Z"),
        log: NOOP_LOG,
        steps: {
          metrics: async () => {
            throw new Error("vk api down");
          },
          digest: async () => {
            digestRuns += 1;
            return { sent: true };
          },
        },
      },
    );

    const failed = await sched.tick("metrics");
    expect(failed).toMatchObject({ ok: false, step: "metrics" });
    expect(failed.ok === false && failed.error).toContain("vk api down");

    const dig = await sched.tick("digest");
    expect(dig.ok).toBe(true);
    expect(digestRuns).toBe(1);

    // Recorded independently: metrics keeps its error, digest its success.
    const health = sched.health();
    expect(health.metrics.last_success).toBeNull();
    expect(health.metrics.last_error).toContain("vk api down");
    expect(health.digest.last_success).toBe("2026-01-02T10:00:00.000Z");
    expect(health.digest.last_error).toBeNull();
  });

  it("GWT-3: a step with interval 0 is never scheduled", async () => {
    const fired: Array<() => void> = [];
    const intervals: number[] = [];
    const setIv = vi.fn((fn: () => void, ms: number) => {
      fired.push(fn);
      intervals.push(ms);
      return fired.length as unknown as NodeJS.Timeout;
    });
    const clearIv = vi.fn();
    const calls = { ingest: 0, metrics: 0, digest: 0 };
    const sched = new Scheduler(
      { ingest: 0, metrics: 60_000, digest: 0 },
      {
        store,
        log: NOOP_LOG,
        setIntervalFn: setIv as unknown as typeof setInterval,
        clearIntervalFn: clearIv as unknown as typeof clearInterval,
        steps: quietSteps(calls),
      },
    );

    sched.start();
    // Only metrics (60s) is armed; ingest/digest at 0 never reach the timer.
    expect(setIv).toHaveBeenCalledTimes(1);
    expect(intervals).toEqual([60_000]);

    fired[0]();
    await vi.waitFor(() => expect(calls.metrics).toBe(1));
    expect(calls.ingest).toBe(0);
    expect(calls.digest).toBe(0);

    sched.stop();
    expect(clearIv).toHaveBeenCalledTimes(1);
  });

  it("skips an overlapping tick of the same step while other steps stay live", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ingestRuns = 0;
    const sched = new Scheduler(
      {},
      {
        store,
        log: NOOP_LOG,
        steps: {
          ingest: async () => {
            ingestRuns += 1;
            await gate;
          },
          metrics: async () => "metrics-ok",
        },
      },
    );

    const first = sched.tick("ingest");
    const overlap = await sched.tick("ingest");
    expect(overlap).toMatchObject({ ok: true, step: "ingest", skipped: true });
    expect(sched.isRunning("ingest")).toBe(true);

    // A different step is unaffected by the in-flight ingest tick.
    const other = await sched.tick("metrics");
    expect(other).toMatchObject({ ok: true, result: "metrics-ok" });

    release();
    expect((await first).ok).toBe(true);
    expect(ingestRuns).toBe(1);
    expect(sched.isRunning("ingest")).toBe(false);
  });

  it("composes cadence flags into the digest sendMessage payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-manager-charter-"));
    const charterPath = join(dir, "brand.yaml");
    writeFileSync(
      charterPath,
      [
        "audience: devs",
        "tone: concrete",
        "content_pillars:",
        "  - name: Authority",
        "    objective: authority",
        "cadence:",
        "  - platform: vk",
        "    posts_per_week: 2",
        "window_days: 14",
      ].join("\n"),
    );

    const sentTexts: string[] = [];
    const tgFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/sendMessage") && typeof init?.body === "string") {
        sentTexts.push((JSON.parse(init.body) as { text?: string }).text ?? "");
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });
    // LLM down -> the digest falls back to raw stats and still delivers.
    const llmFetch = vi.fn(async () => {
      throw new Error("gateway down");
    });

    const sched = new Scheduler(
      { digest: 0 },
      {
        store,
        charterPath,
        telegram: { token: "tok", chatId: "chat", fetch: tgFetch },
        llm: { fetch: llmFetch },
        log: NOOP_LOG,
      },
    );

    const res = await sched.tick("digest");
    expect(res.ok).toBe(true);
    expect(sentTexts).toHaveLength(1);
    // An empty store against a 2-posts/week vk charter must flag cadence.
    expect(sentTexts[0]).toContain("Cadence (14d window):");
    expect(sentTexts[0]).toContain("vk below cadence");
  });

  it("still delivers the digest when the charter cannot be loaded", async () => {
    const sentTexts: string[] = [];
    const tgFetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (typeof init?.body === "string") {
        sentTexts.push((JSON.parse(init.body) as { text?: string }).text ?? "");
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const llmFetch = vi.fn(async () => {
      throw new Error("gateway down");
    });
    const sched = new Scheduler(
      {},
      {
        store,
        charterPath: join(tmpdir(), "no-such-brand.yaml"),
        telegram: { token: "tok", chatId: "chat", fetch: tgFetch },
        llm: { fetch: llmFetch },
        log: NOOP_LOG,
      },
    );

    const res = await sched.tick("digest");
    expect(res.ok).toBe(true);
    expect(sentTexts).toHaveLength(1);
    expect(sentTexts[0]).not.toContain("Cadence");
  });
});

describe("cadenceAwareFetch", () => {
  it("appends the flags section to sendMessage text only", async () => {
    const seen: { url: string; body?: string }[] = [];
    const base = vi.fn(async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), body: typeof init?.body === "string" ? init.body : undefined });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const cadence = {
      flags: ["vk below cadence"],
      stats: {
        perPlatform: { vk: 0, linkedin: 0, facebook: 0, instagram: 0, youtube: 0 },
        perObjective: { authority: 0, proof: 0, community: 0 },
        window_days: 14,
      },
    };
    const wrapped = cadenceAwareFetch(base, cadence);

    await wrapped("https://api.telegram.org/botT/sendMessage", {
      method: "POST",
      body: JSON.stringify({ chat_id: "c", text: "digest body" }),
    });
    const sendBody = JSON.parse(seen[0].body ?? "{}") as { text?: string };
    expect(sendBody.text).toContain("digest body");
    expect(sendBody.text).toContain("- vk below cadence");

    await wrapped("https://api.telegram.org/botT/answerCallbackQuery", {
      method: "POST",
      body: JSON.stringify({ callback_query_id: "q", text: "toast" }),
    });
    const ackBody = JSON.parse(seen[1].body ?? "{}") as { text?: string };
    expect(ackBody.text).toBe("toast");
  });
});

describe("handleTelegramUpdate", () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = memStore();
  });

  it("routes callback_query pipeline:<rec> into sendToPipeline and answers the callback", async () => {
    const sendToPipeline = vi.fn(async (_store: unknown, _recId: string) => ({ ok: true }));
    const answer = vi.fn(async (_id: string, _opts?: unknown) => ({ ok: true }));
    const result = await handleTelegramUpdate(
      {
        update_id: 1,
        callback_query: { id: "cb-1", data: "pipeline:rec-7", from: { id: 5 } },
      },
      { store, sendToPipeline, answerCallbackQuery: answer, log: NOOP_LOG },
    );

    expect(result).toMatchObject({ handled: true, ok: true });
    expect(sendToPipeline).toHaveBeenCalledWith(store, "rec-7", undefined);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer.mock.calls[0][0]).toBe("cb-1");
    expect(answer.mock.calls[0][1]).toMatchObject({ text: "Brief sent to pipeline" });
  });

  it("still answers the callback when sendToPipeline reports a failure", async () => {
    const sendToPipeline = vi.fn(async (_store: unknown, _recId: string) => ({
      ok: false,
      error: "invalid_status",
    }));
    const answer = vi.fn(async (_id: string, _opts?: unknown) => ({ ok: true }));
    const result = await handleTelegramUpdate(
      { callback_query: { id: "cb-2", data: "pipeline:rec-9" } },
      { store, sendToPipeline, answerCallbackQuery: answer, log: NOOP_LOG },
    );

    expect(result).toMatchObject({ handled: true, ok: false, error: "invalid_status" });
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer.mock.calls[0][1]).toMatchObject({ text: "Send to pipeline failed" });
  });

  it("answers even when the sendToPipeline implementation throws", async () => {
    const sendToPipeline = vi.fn(async (_store: unknown, _recId: string) => {
      throw new Error("store exploded");
    });
    const answer = vi.fn(async (_id: string, _opts?: unknown) => ({ ok: true }));
    const result = await handleTelegramUpdate(
      { callback_query: { id: "cb-3", data: "pipeline:rec-1" } },
      { store, sendToPipeline, answerCallbackQuery: answer, log: NOOP_LOG },
    );

    expect(result.ok).toBe(false);
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it("ignores updates without a callback_query", async () => {
    const answer = vi.fn(async (_id: string, _opts?: unknown) => ({ ok: true }));
    const result = await handleTelegramUpdate(
      { update_id: 2, message: { text: "hi" } },
      { store, answerCallbackQuery: answer, log: NOOP_LOG },
    );
    expect(result).toEqual({ handled: false, ok: true });
    expect(answer).not.toHaveBeenCalled();
  });
});

describe("answerCallbackQuery", () => {
  it("posts to the Bot API and reports the envelope", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }),
    );
    const res = await answerCallbackQuery("q-1", {
      token: "tok",
      text: "done",
      fetch: fetchImpl,
      log: NOOP_LOG,
    });
    expect(res.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/answerCallbackQuery");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.callback_query_id).toBe("q-1");
    expect(body.text).toBe("done");
  });

  it("never throws on transport failure", async () => {
    const res = await answerCallbackQuery("q-2", {
      token: "tok",
      fetch: async (_url: string | URL, _init?: RequestInit) => {
        throw new Error("net down");
      },
      log: NOOP_LOG,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("net down");
  });
});

describe("HTTP wiring", () => {
  let server: Server;
  let base: string;
  let store: SqliteStore;

  beforeAll(async () => {
    store = memStore();
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    attachScheduler(null);
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("POST /tick/<step> runs the step and updates /health", async () => {
    const calls = { ingest: 0, metrics: 0, digest: 0 };
    const sched = new Scheduler(
      { ingest: 0, metrics: 0, digest: 0 },
      {
        store,
        now: () => new Date("2026-01-02T12:00:00.000Z"),
        log: NOOP_LOG,
        steps: quietSteps(calls),
      },
    );
    attachScheduler(sched);

    const res = await fetch(`${base}/tick/ingest`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.step).toBe("ingest");
    expect(calls.ingest).toBe(1);

    const health = await (await fetch(`${base}/health`)).json();
    expect(health.subsystems.ingest.last_success).toBe("2026-01-02T12:00:00.000Z");
    expect(health.subsystems.ingest.last_error).toBeNull();
    expect(health.subsystems.metrics.last_success).toBeNull();
  });

  it("POST /tick/<unknown> answers 404", async () => {
    const res = await fetch(`${base}/tick/bogus`, { method: "POST" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("a failing step answers 500 and surfaces last_error in /health", async () => {
    const sched = new Scheduler(
      {},
      {
        store,
        log: NOOP_LOG,
        steps: {
          metrics: async () => {
            throw new Error("collector exploded");
          },
        },
      },
    );
    attachScheduler(sched);

    const res = await fetch(`${base}/tick/metrics`, { method: "POST" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("collector exploded");

    const health = await (await fetch(`${base}/health`)).json();
    expect(health.subsystems.metrics.last_error).toContain("collector exploded");
    expect(health.subsystems.metrics.last_success).toBeNull();
  });

  it("POST /telegram/callback consumes pipeline:<rec> via sendToPipeline + answerCallbackQuery", async () => {
    const sendToPipeline = vi.fn(async (_store: unknown, _recId: string) => ({ ok: true }));
    const answer = vi.fn(async (_id: string, _opts?: unknown) => ({ ok: true }));
    const sched = new Scheduler(
      {},
      { store, sendToPipeline, answerCallbackQuery: answer, log: NOOP_LOG },
    );
    attachScheduler(sched);

    const res = await fetch(`${base}/telegram/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        update_id: 42,
        callback_query: { id: "cb-9", data: "pipeline:rec-3", from: { id: 1 } },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.handled).toBe(true);
    expect(sendToPipeline).toHaveBeenCalledWith(store, "rec-3", undefined);
    expect(answer).toHaveBeenCalledTimes(1);
  });
});
