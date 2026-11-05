/**
 * Minimal Telegram Bot API client (roadmap item_06).
 *
 * One method is enough for the digest loop: `sendMessage` delivering
 * the digest text with an optional inline keyboard of action buttons
 * (e.g. "Send to Pipeline" carrying a `pipeline:<rec_id>` callback).
 *
 * Credentials come from opts or env ({@link ENV_TG_BOT_TOKEN},
 * {@link ENV_TG_CHAT_ID}; registered in src/config.ts) resolved at
 * CALL time, never at import. Messages are sent as PLAIN TEXT - no
 * parse_mode, no escaping: digest content is model-generated prose,
 * and Markdown/HTML parsing would only add an injection footgun.
 *
 * Delivery policy: this module NEVER throws. Telegram being down must
 * not kill a scheduler tick, so every failure - missing credentials,
 * timeout, non-2xx, `ok:false` envelope - is logged and reported back
 * as `{ok: false, error}` for the caller to surface.
 */
import { ENV_TG_BOT_TOKEN, ENV_TG_CHAT_ID } from "./config.js";
import { causeMessage } from "./errors.js";
import type { FetchLike } from "./llm.js";

export const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Default per-call timeout, ~10s per the roadmap. */
export const DEFAULT_TELEGRAM_TIMEOUT_MS = 10_000;

/** One button of a Telegram inline keyboard row. */
export interface InlineButton {
  text: string;
  /** Payload delivered back in callback_query.data, <= 64 bytes. */
  callback_data: string;
}

export interface TelegramSendOptions {
  /** Bot API token; defaults to env TG_BOT_TOKEN. */
  token?: string;
  /** Target chat id; defaults to env TG_CHAT_ID. */
  chatId?: string;
  /**
   * Inline keyboard as rows of buttons; serialized into
   * `reply_markup.inline_keyboard`. Omit for a plain message.
   */
  inlineKeyboard?: InlineButton[][];
  /** fetch implementation (Node global by default); injectable for tests. */
  fetch?: FetchLike;
  /** Per-call timeout in ms, default {@link DEFAULT_TELEGRAM_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Log sink for failures; defaults to console.error. */
  log?: (msg: string) => void;
}

/**
 * Delivery outcome. `ok:false` always carries a human-readable
 * `error`; the function never throws, so this is the ONLY failure
 * channel a caller needs to inspect.
 */
export interface TelegramSendResult {
  ok: boolean;
  error?: string;
}

function resolveCredentials(opts: TelegramSendOptions): { token?: string; chatId?: string } {
  const token = (opts.token ?? process.env[ENV_TG_BOT_TOKEN])?.trim();
  const chatId = (opts.chatId ?? process.env[ENV_TG_CHAT_ID])?.trim();
  return { token: token || undefined, chatId: chatId || undefined };
}

/**
 * Send `text` to the configured chat, optionally with an inline
 * keyboard. Returns `{ok:true}` on Telegram's `{ok:true}` envelope,
 * `{ok:false,error}` on every failure path; never throws.
 */
export async function sendMessage(
  text: string,
  opts: TelegramSendOptions = {},
): Promise<TelegramSendResult> {
  const log = opts.log ?? ((msg: string) => console.error(msg));
  const { token, chatId } = resolveCredentials(opts);
  if (token === undefined || chatId === undefined) {
    const error = "telegram not configured (TG_BOT_TOKEN/TG_CHAT_ID missing)";
    log(`[digest] telegram sendMessage skipped: ${error}`);
    return { ok: false, error };
  }

  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TELEGRAM_TIMEOUT_MS;

  const payload: Record<string, unknown> = { chat_id: chatId, text };
  if (opts.inlineKeyboard !== undefined && opts.inlineKeyboard.length > 0) {
    payload.reply_markup = { inline_keyboard: opts.inlineKeyboard };
  }

  let res: Response;
  try {
    res = await fetchImpl(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const error = `telegram sendMessage transport failure: ${causeMessage(e)}`;
    log(`[digest] ${error}`);
    return { ok: false, error };
  }

  let body: { ok?: boolean; description?: string };
  try {
    body = (await res.json()) as { ok?: boolean; description?: string };
  } catch (e) {
    const error = `telegram sendMessage returned non-JSON body (HTTP ${res.status}): ${causeMessage(e)}`;
    log(`[digest] ${error}`);
    return { ok: false, error };
  }

  if (!res.ok || body.ok !== true) {
    const error = `telegram sendMessage failed (HTTP ${res.status}): ${body.description ?? "unknown"}`;
    log(`[digest] ${error}`);
    return { ok: false, error };
  }
  return { ok: true };
}
