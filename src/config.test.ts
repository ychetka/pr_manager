import { describe, expect, it } from "vitest";
import {
  DEFAULT_DB_PATH,
  DEFAULT_PORT,
  ENV_DB_PATH,
  ENV_MOUNT_SENTINEL,
  ENV_PORT,
  ENV_REQUIRE_MOUNT,
  ENV_STATE_ROOT,
  loadConfig,
} from "./config.js";

describe("loadConfig", () => {
  it("fails fast when N8N_STATE_ROOT is missing or blank", () => {
    expect(() => loadConfig({})).toThrow(/N8N_STATE_ROOT/);
    expect(() => loadConfig({ [ENV_STATE_ROOT]: "  " })).toThrow(/N8N_STATE_ROOT/);
  });

  it("reads required env and applies defaults", () => {
    const cfg = loadConfig({ [ENV_STATE_ROOT]: "/mnt/n8n" });
    expect(cfg.stateRoot).toBe("/mnt/n8n");
    expect(cfg.dbPath).toBe(DEFAULT_DB_PATH);
    expect(cfg.port).toBe(DEFAULT_PORT);
    expect(cfg.mountHealth).toEqual({});
  });

  it("reads DB_PATH and PORT overrides", () => {
    const cfg = loadConfig({
      [ENV_STATE_ROOT]: "/mnt/n8n",
      [ENV_DB_PATH]: ":memory:",
      [ENV_PORT]: "9001",
    });
    expect(cfg.dbPath).toBe(":memory:");
    expect(cfg.port).toBe(9001);
  });

  it("rejects a non-numeric or out-of-range PORT", () => {
    expect(() => loadConfig({ [ENV_STATE_ROOT]: "/m", [ENV_PORT]: "abc" })).toThrow(/PORT/);
    expect(() => loadConfig({ [ENV_STATE_ROOT]: "/m", [ENV_PORT]: "70000" })).toThrow(/PORT/);
  });

  it("builds mountHealth options from env", () => {
    const cfg = loadConfig({
      [ENV_STATE_ROOT]: "/m",
      [ENV_REQUIRE_MOUNT]: "1",
      [ENV_MOUNT_SENTINEL]: ".mounted",
    });
    expect(cfg.mountHealth).toEqual({ requireMount: true, sentinel: ".mounted" });
  });
});
