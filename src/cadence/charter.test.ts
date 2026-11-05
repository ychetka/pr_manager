import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PILLAR_IMBALANCE_PCT,
  DEFAULT_WINDOW_DAYS,
  ENV_BRAND_CHARTER_PATH,
  loadCharter,
} from "./charter.js";

const REPO_CHARTER = fileURLToPath(new URL("../../brand.yaml", import.meta.url));

const tmpDirs: string[] = [];

function tmpCharter(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "charter-"));
  tmpDirs.push(dir);
  const path = join(dir, "brand.yaml");
  writeFileSync(path, content, "utf8");
  return path;
}

const MINIMAL = `
audience: developers
tone: practitioner
content_pillars:
  - name: Authority
    objective: authority
cadence:
  - platform: vk
    posts_per_week: 2
`;

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  vi.unstubAllEnvs();
});

describe("loadCharter", () => {
  it("loads the repo brand.yaml with all sections", () => {
    const charter = loadCharter(REPO_CHARTER);

    expect(charter.audience).toContain("developer");
    expect(charter.tone).toContain("practitioner");
    expect(charter.content_pillars.map((p) => p.objective)).toEqual([
      "authority",
      "proof",
      "community",
    ]);
    const vk = charter.cadence.find((c) => c.platform === "vk");
    expect(vk?.posts_per_week).toBe(2);
    for (const p of ["linkedin", "facebook", "instagram"]) {
      expect(charter.cadence.find((c) => c.platform === p)?.posts_per_week).toBe(1);
    }
    expect(charter.window_days).toBe(14);
    expect(charter.thresholds.pillar_imbalance_pct).toBe(70);
  });

  it("applies documented defaults for optional sections", () => {
    const charter = loadCharter(tmpCharter(MINIMAL));

    expect(charter.window_days).toBe(DEFAULT_WINDOW_DAYS);
    expect(charter.thresholds.pillar_imbalance_pct).toBe(DEFAULT_PILLAR_IMBALANCE_PCT);
  });

  it("resolves the path from BRAND_CHARTER_PATH when no arg is given", () => {
    const path = tmpCharter(MINIMAL);
    vi.stubEnv(ENV_BRAND_CHARTER_PATH, path);

    const charter = loadCharter();
    expect(charter.audience).toBe("developers");
  });

  it("throws a plain Error on a missing file", () => {
    expect(() => loadCharter("/nonexistent/brand.yaml")).toThrowError(/brand charter/);
  });

  it("rejects a document missing required fields", () => {
    expect(() => loadCharter(tmpCharter("tone: x\n"))).toThrowError(/audience/);
    expect(() => loadCharter(tmpCharter("audience: a\ntone: t\n"))).toThrowError(/content_pillars/);
  });

  it("rejects a pillar objective outside the model union", () => {
    const path = tmpCharter(`
audience: developers
tone: practitioner
content_pillars:
  - name: Vibes
    objective: vibes
cadence:
  - platform: vk
    posts_per_week: 1
`);
    expect(() => loadCharter(path)).toThrowError(/objective/);
  });

  it("rejects a non-numeric or negative cadence", () => {
    expect(() =>
      loadCharter(tmpCharter(`${MINIMAL.replace("posts_per_week: 2", 'posts_per_week: "lots"')}`)),
    ).toThrowError(/posts_per_week/);
    expect(() =>
      loadCharter(tmpCharter(`${MINIMAL.replace("posts_per_week: 2", "posts_per_week: -1")}`)),
    ).toThrowError(/posts_per_week/);
  });

  it("rejects an unknown platform in cadence", () => {
    const path = tmpCharter(MINIMAL.replace("platform: vk", "platform: tiktok"));
    expect(() => loadCharter(path)).toThrowError(/platform/);
  });

  it("rejects duplicate platforms in cadence", () => {
    const path = tmpCharter(`${MINIMAL}  - platform: vk\n    posts_per_week: 5\n`);
    expect(() => loadCharter(path)).toThrowError(/duplicates/);
  });

  it("rejects a non-positive window_days and out-of-range threshold", () => {
    expect(() => loadCharter(tmpCharter(`${MINIMAL}window_days: 0\n`))).toThrowError(/window_days/);
    expect(() =>
      loadCharter(tmpCharter(`${MINIMAL}thresholds:\n  pillar_imbalance_pct: 140\n`)),
    ).toThrowError(/pillar_imbalance_pct/);
  });
});
