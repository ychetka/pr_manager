/**
 * Env-driven service configuration (roadmap item_04).
 *
 * Central place that reads process.env so subsystems never touch it
 * directly. Required values fail fast at startup with a plain Error
 * (config load happens before any subsystem is up, so there is no
 * service-error context to classify it against yet).
 */

import type { MountHealthOptions } from "./ingest/contract.js";

export const ENV_STATE_ROOT = "N8N_STATE_ROOT";
export const ENV_DB_PATH = "DB_PATH";
export const ENV_PORT = "PORT";
export const ENV_REQUIRE_MOUNT = "N8N_STATE_REQUIRE_MOUNT";
export const ENV_MOUNT_SENTINEL = "N8N_STATE_SENTINEL";
export const ENV_VK_TOKEN = "VK_TOKEN";
export const ENV_LLM_GATEWAY_URL = "LLM_GATEWAY_URL";
export const ENV_TG_BOT_TOKEN = "TG_BOT_TOKEN";
export const ENV_TG_CHAT_ID = "TG_CHAT_ID";
export const ENV_N8N_WEBHOOK_BASE = "N8N_WEBHOOK_BASE";
export const ENV_CONTENT_GEN_WEBHOOK_URL = "CONTENT_GEN_WEBHOOK_URL";

export const DEFAULT_DB_PATH = "./data/pr_manager.db";
export const DEFAULT_PORT = 8789;
export const DEFAULT_LLM_GATEWAY_URL = "http://127.0.0.1:8787";
export const DEFAULT_N8N_WEBHOOK_BASE = "http://127.0.0.1:5678";

export interface ServiceConfig {
  /**
   * Root of the mounted n8n-state volume the ingester reads
   * (env {@link ENV_STATE_ROOT}). Required: the service is stateless
   * without its upstream state, so a missing root fails startup.
   */
  stateRoot: string;
  /**
   * SQLite file the StateStore persists to (env {@link ENV_DB_PATH},
   * default {@link DEFAULT_DB_PATH}). The literal ":memory:" selects an
   * in-memory database (tests/dev).
   */
  dbPath: string;
  /** HTTP listen port (env {@link ENV_PORT}, default {@link DEFAULT_PORT}). */
  port: number;
  /**
   * Extra hardening for checkMountHealth, driven by env:
   * {@link ENV_REQUIRE_MOUNT}=1 requires stateRoot to be a real mount
   * point; {@link ENV_MOUNT_SENTINEL} names a marker file that must
   * exist under the root.
   */
  mountHealth: MountHealthOptions;
  /**
   * VK API access token for the metrics collector (env
   * {@link ENV_VK_TOKEN}). Optional at startup: the collector is its
   * only consumer and must fail with a clear error when it RUNS
   * without a token, so loadConfig passes the value through without
   * requiring it.
   */
  vkToken?: string;
  /**
   * llm-gateway base URL (env {@link ENV_LLM_GATEWAY_URL}, default
   * {@link DEFAULT_LLM_GATEWAY_URL}); the digest calls `POST {url}/run`.
   */
  llmGatewayUrl: string;
  /**
   * Telegram Bot API token (env {@link ENV_TG_BOT_TOKEN}) and target
   * chat id (env {@link ENV_TG_CHAT_ID}) for digest delivery. Both
   * optional at startup: a missing pair degrades the digest tick to
   * a logged skip, never a startup failure.
   */
  tgBotToken?: string;
  tgChatId?: string;
  /**
   * Base URL of the shared_person n8n instance (env
   * {@link ENV_N8N_WEBHOOK_BASE}, default {@link DEFAULT_N8N_WEBHOOK_BASE});
   * Send-to-Pipeline posts to `{base}/webhook/content-gen`.
   * {@link ENV_CONTENT_GEN_WEBHOOK_URL} overrides the full URL outright.
   */
  n8nWebhookBase: string;
  /** Full content-gen webhook URL override (env {@link ENV_CONTENT_GEN_WEBHOOK_URL}). */
  contentGenWebhookUrl?: string;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`missing required env var: ${name}`);
  }
  return value;
}

/** Read the service configuration from an env map (defaults to process.env). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const port = env[ENV_PORT] === undefined ? DEFAULT_PORT : Number(env[ENV_PORT]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid ${ENV_PORT}: ${JSON.stringify(env[ENV_PORT])} (expected 1..65535)`);
  }

  const mountHealth: MountHealthOptions = {};
  if (env[ENV_REQUIRE_MOUNT] === "1" || env[ENV_REQUIRE_MOUNT] === "true") {
    mountHealth.requireMount = true;
  }
  if (env[ENV_MOUNT_SENTINEL] !== undefined && env[ENV_MOUNT_SENTINEL].trim() !== "") {
    mountHealth.sentinel = env[ENV_MOUNT_SENTINEL];
  }

  const cfg: ServiceConfig = {
    stateRoot: requireEnv(env, ENV_STATE_ROOT),
    dbPath: env[ENV_DB_PATH] ?? DEFAULT_DB_PATH,
    port,
    mountHealth,
    llmGatewayUrl: env[ENV_LLM_GATEWAY_URL]?.trim() || DEFAULT_LLM_GATEWAY_URL,
    n8nWebhookBase: env[ENV_N8N_WEBHOOK_BASE]?.trim() || DEFAULT_N8N_WEBHOOK_BASE,
  };
  const vkToken = env[ENV_VK_TOKEN];
  if (vkToken !== undefined && vkToken.trim() !== "") {
    cfg.vkToken = vkToken.trim();
  }
  const tgBotToken = env[ENV_TG_BOT_TOKEN];
  if (tgBotToken !== undefined && tgBotToken.trim() !== "") {
    cfg.tgBotToken = tgBotToken.trim();
  }
  const tgChatId = env[ENV_TG_CHAT_ID];
  if (tgChatId !== undefined && tgChatId.trim() !== "") {
    cfg.tgChatId = tgChatId.trim();
  }
  const contentGenWebhookUrl = env[ENV_CONTENT_GEN_WEBHOOK_URL];
  if (contentGenWebhookUrl !== undefined && contentGenWebhookUrl.trim() !== "") {
    cfg.contentGenWebhookUrl = contentGenWebhookUrl.trim();
  }
  return cfg;
}
