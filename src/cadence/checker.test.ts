import { afterEach, describe, expect, it } from "vitest";
import type { ContentItem, Objective, Platform } from "../model/contract.js";
import { SqliteStore } from "../store/sqlite.js";
import type { BrandCharter } from "./charter.js";
import {
  type CadenceResult,
  cadenceDigestSection,
  checkCadence,
  injectFlagsIntoDigest,
} from "./checker.js";

const FIXED_NOW = new Date("2026-04-15T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const stores: SqliteStore[] = [];

function memStore(): SqliteStore {
  const s = new SqliteStore(":memory:");
  s.migrate();
  stores.push(s);
  return s;
}

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
});

function makeCharter(over: Partial<BrandCharter> = {}): BrandCharter {
  return {
    audience: "developers",
    content_pillars: [
      { name: "Authority", objective: "authority" },
      { name: "Proof", objective: "proof" },
      { name: "Community", objective: "community" },
    ],
    tone: "practitioner, concrete, no fluff",
    cadence: [
      { platform: "vk", posts_per_week: 2 },
      { platform: "linkedin", posts_per_week: 1 },
    ],
    window_days: 14,
    thresholds: { pillar_imbalance_pct: 70 },
    ...over,
  };
}

function publishedItem(
  id: string,
  over: {
    platforms?: Platform[];
    objective?: Objective;
    published_at?: string;
    status?: "published" | "measured";
  } = {},
): ContentItem {
  const published_at = over.published_at ?? "2026-04-10T12:00:00.000Z";
  return {
    id,
    source_kind: "n8n",
    status: over.status ?? "published",
    platform_refs: over.platforms ?? ["vk"],
    published_urls: [`https://example.test/${id}`],
    objective: over.objective ?? "authority",
    timestamps: {
      created_at: published_at,
      updated_at: published_at,
      published_at,
    },
  };
}

const daysAgo = (n: number): string => new Date(FIXED_NOW.getTime() - n * DAY_MS).toISOString();

describe("checkCadence", () => {
  it("GWT-1: Given 0 vk posts in 14d vs a 2/week target, When checked, Then 'vk below cadence' flags", () => {
    const store = memStore();
    // Drafts and pipeline items must not count as published history.
    store.upsertContentItem({
      ...publishedItem("d1"),
      status: "draft",
      published_urls: [],
      timestamps: {
        created_at: daysAgo(3),
        updated_at: daysAgo(3),
      },
    });
    const result = checkCadence(store, makeCharter(), { now: FIXED_NOW });

    expect(result.flags).toContain("vk below cadence");
    expect(result.flags).toContain("linkedin below cadence");
    expect(result.stats.perPlatform.vk).toBe(0);
    expect(result.stats.window_days).toBe(14);
  });

  it("GWT-2: Given a fresh vk post today, When checked, Then no vk below-cadence flag", () => {
    const store = memStore();
    // One post is still below floor(2 * 14/7) = 4, but it went out
    // within the fresh window, so cadence is actively being kept.
    store.upsertContentItem(
      publishedItem("fresh-1", {
        published_at: new Date(FIXED_NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      }),
    );
    const result = checkCadence(store, makeCharter(), { now: FIXED_NOW });

    expect(result.flags).not.toContain("vk below cadence");
    // Other charter platforms still flag - freshness is per-platform.
    expect(result.flags).toContain("linkedin below cadence");
    expect(result.stats.perPlatform.vk).toBe(1);
  });

  it("GWT-3: Given >70% of windowed posts share one pillar, When checked, Then 'pillar imbalance' flags", () => {
    const store = memStore();
    for (let i = 1; i <= 4; i++) {
      store.upsertContentItem(
        publishedItem(`a${i}`, { objective: "authority", published_at: daysAgo(i) }),
      );
    }
    store.upsertContentItem(publishedItem("p1", { objective: "proof", published_at: daysAgo(2) }));

    const result = checkCadence(store, makeCharter(), { now: FIXED_NOW });

    expect(result.flags).toContain("pillar imbalance: authority");
    // 5 vk posts meet floor(2 * 14/7) = 4 - no cadence flag for vk.
    expect(result.flags).not.toContain("vk below cadence");
    expect(result.stats.perObjective.authority).toBe(4);
    expect(result.stats.perObjective.proof).toBe(1);
  });

  it("GWT-4: Given 0 proof posts in 14d, When checked, Then 'objective gap: proof' flags", () => {
    const store = memStore();
    store.upsertContentItem(
      publishedItem("a1", { objective: "authority", published_at: daysAgo(3) }),
    );
    store.upsertContentItem(
      publishedItem("c1", { objective: "community", published_at: daysAgo(4) }),
    );

    const result = checkCadence(store, makeCharter(), { now: FIXED_NOW });

    expect(result.flags).toContain("objective gap: proof");
    expect(result.flags).not.toContain("objective gap: authority");
    expect(result.flags).not.toContain("objective gap: community");
  });

  it("scores items missing published_at by created_at, never by updated_at", () => {
    const store = memStore();
    // A measured item created 20d ago but re-ingested an hour ago:
    // under an updated_at fallback it would enter the window AND mark
    // vk "fresh", suppressing below cadence. created_at keeps it out.
    const stale = publishedItem("m-stale", { status: "measured" });
    stale.timestamps = {
      created_at: daysAgo(20),
      updated_at: new Date(FIXED_NOW.getTime() - 60 * 60 * 1000).toISOString(),
    };
    store.upsertContentItem(stale);
    // No published_at but created 2d ago: counted via created_at.
    const recent = publishedItem("m-recent", { status: "measured" });
    recent.timestamps = {
      created_at: daysAgo(2),
      updated_at: daysAgo(2),
    };
    store.upsertContentItem(recent);

    const result = checkCadence(store, makeCharter(), { now: FIXED_NOW });

    expect(result.stats.perPlatform.vk).toBe(1);
    expect(result.flags).toContain("vk below cadence");
  });

  it("does not flag pillar imbalance below the minimum sample", () => {
    const store = memStore();
    // 3 posts all serving one objective = 100% share, but the sample
    // is below MIN_IMBALANCE_SAMPLE so no imbalance flag is emitted.
    for (let i = 1; i <= 3; i++) {
      store.upsertContentItem(
        publishedItem(`a${i}`, { objective: "authority", published_at: daysAgo(i + 1) }),
      );
    }

    const result = checkCadence(store, makeCharter(), { now: FIXED_NOW });

    expect(result.flags).not.toContain("pillar imbalance: authority");
    // Gap flags do not depend on the sample size.
    expect(result.flags).toContain("objective gap: proof");
    expect(result.flags).toContain("objective gap: community");
  });

  it("ignores posts outside the window and 'measured' items count", () => {
    const store = memStore();
    // Published 20 days ago: outside the 14d window.
    store.upsertContentItem(publishedItem("old-1", { published_at: daysAgo(20) }));
    // Measured items still count toward the window.
    store.upsertContentItem(
      publishedItem("m1", { status: "measured", published_at: daysAgo(5), objective: "proof" }),
    );

    const result = checkCadence(store, makeCharter(), { now: FIXED_NOW });

    expect(result.stats.perPlatform.vk).toBe(1);
    expect(result.stats.perObjective.proof).toBe(1);
    expect(result.flags).toContain("vk below cadence");
  });

  it("honors an opts.windowDays override and multi-platform posts count per ref", () => {
    const store = memStore();
    store.upsertContentItem(
      publishedItem("x1", { platforms: ["vk", "linkedin"], published_at: daysAgo(2) }),
    );

    const result = checkCadence(store, makeCharter(), { now: FIXED_NOW, windowDays: 7 });

    expect(result.stats.window_days).toBe(7);
    expect(result.stats.perPlatform.vk).toBe(1);
    expect(result.stats.perPlatform.linkedin).toBe(1);
    // floor(2 * 7/7) = 2 for vk, floor(1 * 7/7) = 1 for linkedin.
    expect(result.flags).toContain("vk below cadence");
    expect(result.flags).not.toContain("linkedin below cadence");
  });

  it("renders flags as a digest section and injects them into digest text", () => {
    const result: CadenceResult = {
      flags: ["vk below cadence", "objective gap: proof"],
      stats: {
        perPlatform: { vk: 0, linkedin: 0, facebook: 0, instagram: 0, youtube: 0 },
        perObjective: { authority: 0, proof: 0, community: 0 },
        window_days: 14,
      },
    };

    const section = cadenceDigestSection(result);
    expect(section).toContain("Cadence (14d window):");
    expect(section).toContain("- vk below cadence");
    expect(section).toContain("- objective gap: proof");

    const digest = injectFlagsIntoDigest("PR Manager digest - 2026-04-15", result);
    expect(digest).toContain("PR Manager digest - 2026-04-15");
    expect(digest).toContain("- vk below cadence");

    const clean = cadenceDigestSection({ ...result, flags: [] });
    expect(clean).toContain("- on track");
  });
});
