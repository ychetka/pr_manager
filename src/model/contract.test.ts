import { describe, expect, it } from "vitest";
import {
  type ContentItem,
  type ContentStatus,
  InvalidTransition,
  parsePlatform,
  transitionStatus,
  UnknownPlatform,
} from "./contract.js";

const T0 = "2026-01-01T00:00:00.000Z";

function makeItem(status: ContentStatus, over: Partial<ContentItem> = {}): ContentItem {
  return {
    id: "item-1",
    source_kind: "n8n",
    status,
    platform_refs: ["vk"],
    published_urls: [],
    objective: "authority",
    timestamps: { created_at: T0, updated_at: T0 },
    ...over,
  };
}

describe("parsePlatform", () => {
  it("accepts every supported platform", () => {
    for (const p of ["vk", "linkedin", "facebook", "instagram", "youtube"] as const) {
      expect(parsePlatform(p)).toBe(p);
    }
  });

  it("throws UnknownPlatform on an unknown platform", () => {
    expect(() => parsePlatform("tiktok")).toThrow(UnknownPlatform);
    try {
      parsePlatform("tiktok");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownPlatform);
      expect((e as UnknownPlatform).code).toBe("UNKNOWN_PLATFORM");
    }
  });
});

describe("transitionStatus", () => {
  it("moves forward along the pipeline and refreshes updated_at", () => {
    const item = makeItem("draft");
    const next = transitionStatus(item, "moderation", new Date("2026-01-02T00:00:00.000Z"));

    expect(next.status).toBe("moderation");
    expect(next.timestamps.updated_at).toBe("2026-01-02T00:00:00.000Z");
    expect(next.timestamps.created_at).toBe(T0);
  });

  it("is pure: the input item is not mutated", () => {
    const item = makeItem("draft");
    transitionStatus(item, "moderation");
    expect(item.status).toBe("draft");
    expect(item.timestamps.updated_at).toBe(T0);
  });

  it("allows forward jumps over stages (draft -> approved)", () => {
    const next = transitionStatus(makeItem("draft"), "approved");
    expect(next.status).toBe("approved");
  });

  it("walks the whole linear chain idea -> measured", () => {
    const chain: ContentStatus[] = [
      "brief",
      "draft",
      "moderation",
      "approved",
      "queued",
      "published",
      "measured",
    ];
    let item = makeItem("idea");
    for (const to of chain) {
      item = transitionStatus(item, to);
      expect(item.status).toBe(to);
    }
  });

  it("sets published_at when the item is published", () => {
    const when = new Date("2026-02-01T12:00:00.000Z");
    const next = transitionStatus(makeItem("queued"), "published", when);
    expect(next.status).toBe("published");
    expect(next.timestamps.published_at).toBe(when.toISOString());
  });

  it("allows the single backward edge draft -> brief (edit)", () => {
    const next = transitionStatus(makeItem("draft"), "brief");
    expect(next.status).toBe("brief");
  });

  it("rejects other backward moves (published -> draft)", () => {
    const item = makeItem("published");
    expect(() => transitionStatus(item, "draft")).toThrow(InvalidTransition);
    try {
      transitionStatus(item, "draft");
      expect.unreachable();
    } catch (e) {
      expect((e as InvalidTransition).code).toBe("INVALID_TRANSITION");
      expect((e as InvalidTransition).from).toBe("published");
      expect((e as InvalidTransition).to).toBe("draft");
    }
  });

  it("rejects backward moves into moderation (approved -> moderation)", () => {
    expect(() => transitionStatus(makeItem("approved"), "moderation")).toThrow(InvalidTransition);
  });

  it("treats failed as terminal: failed -> queued throws", () => {
    expect(() => transitionStatus(makeItem("failed"), "queued")).toThrow(InvalidTransition);
    expect(() => transitionStatus(makeItem("failed"), "rejected")).toThrow(InvalidTransition);
  });

  it("treats rejected as terminal", () => {
    expect(() => transitionStatus(makeItem("rejected"), "draft")).toThrow(InvalidTransition);
  });

  it("allows terminalizing from any non-terminal status", () => {
    expect(transitionStatus(makeItem("moderation"), "rejected").status).toBe("rejected");
    expect(transitionStatus(makeItem("queued"), "failed").status).toBe("failed");
    expect(transitionStatus(makeItem("measured"), "failed").status).toBe("failed");
  });

  it("same-status transition is a documented no-op", () => {
    const item = makeItem("draft");
    expect(transitionStatus(item, "draft")).toBe(item);
    expect(transitionStatus(makeItem("failed"), "failed").status).toBe("failed");
  });
});
