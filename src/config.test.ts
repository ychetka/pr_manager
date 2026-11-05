import { describe, expect, it } from "vitest";
import {
  DEFAULT_DB_PATH,
  DEFAULT_LLM_GATEWAY_URL,
  DEFAULT_N8N_WEBHOOK_BASE,
  DEFAULT_PORT,
  ENV_CONTENT_GEN_WEBHOOK_URL,
  ENV_DB_PATH,
  ENV_LLM_GATEWAY_URL,
  ENV_MOUNT_SENTINEL,
  ENV_N8N_WEBHOOK_BASE,
  ENV_PORT,
  ENV_REQUIRE_MOUNT,
  ENV_STATE_ROOT,
  ENV_TG_BOT_TOKEN,
  ENV_TG_CHAT_ID,
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

  it("applies digest env vars with defaults and optionals", () => {
    const cfg = loadConfig({ [ENV_STATE_ROOT]: "/m" });
    expect(cfg.llmGatewayUrl).toBe(DEFAULT_LLM_GATEWAY_URL);
    expect(cfg.n8nWebhookBase).toBe(DEFAULT_N8N_WEBHOOK_BASE);
    expect(cfg.tgBotToken).toBeUndefined();
    expect(cfg.tgChatId).toBeUndefined();
    expect(cfg.contentGenWebhookUrl).toBeUndefined();

    const full = loadConfig({
      [ENV_STATE_ROOT]: "/m",
      [ENV_LLM_GATEWAY_URL]: "http://gw:9999",
      [ENV_TG_BOT_TOKEN]: "tok",
      [ENV_TG_CHAT_ID]: " 42 ",
      [ENV_N8N_WEBHOOK_BASE]: "http://n8n:5678",
      [ENV_CONTENT_GEN_WEBHOOK_URL]: "http://n8n:5678/webhook/content-gen",
    });
    expect(full.llmGatewayUrl).toBe("http://gw:9999");
    expect(full.tgBotToken).toBe("tok");
    expect(full.tgChatId).toBe("42");
    expect(full.n8nWebhookBase).toBe("http://n8n:5678");
    expect(full.contentGenWebhookUrl).toBe("http://n8n:5678/webhook/content-gen");
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
