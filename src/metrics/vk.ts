/**
 * VK metrics collector (roadmap item_05).
 *
 * For items referencing the "vk" platform, {@link VkCollector}
 * extracts wall post refs from `published_urls` of the form
 * `https://vk.com/wall<owner>_<post>` (owner may be negative for
 * groups), batches them into `wall.getById` calls (up to
 * {@link VK_BATCH_LIMIT} = 100 posts per call) and maps
 * `response.items[].{views,likes,comments}.count` onto MetricSnapshots
 * whose `raw` keeps the verbatim API item.
 *
 * Auth boundary: the access token comes from the `token` option or env
 * {@link ENV_VK_TOKEN} (registered in src/config.ts). It is resolved
 * when collect() RUNS - never at import - and missing credentials fail
 * the VK slice with a clear "metrics_auth" ServiceError; other
 * platforms' collectors are unaffected.
 *
 * Error policy (VK `error.error_code`):
 * - 9 (rate/flood limit): retry the batch with exponential backoff
 *   (base {@link VkCollectorOptions.baseDelayMs}, x2 per retry) up to
 *   `maxRetries`; exhausted retries -> skip the batch's items + warn.
 * - 5 / 17 ({@link VK_AUTH_ERROR_CODES}): auth failures -> each item
 *   lands in the run's `errored` list with code "metrics_auth" (the v1
 *   metrics_error surrogate - see collector.ts), other batches continue.
 * - any other VK error -> warn + skip the batch's items, continue.
 * - network/HTTP/timeout/malformed-JSON failures -> `errored` entries
 *   with code "metrics_upstream" (retryable per the error taxonomy),
 *   other batches continue.
 */
import { ENV_VK_TOKEN } from "../config.js";
import { causeMessage, METRICS_UPSTREAM, ServiceError } from "../errors.js";
import type { ContentItem, MetricSnapshot } from "../model/contract.js";
import type { CollectContext, CollectOutcome, PlatformCollector } from "./collector.js";

export const VK_API_BASE = "https://api.vk.com/method";
export const VK_API_VERSION = "5.199";
/** Max posts per wall.getById call (VK API limit). */
export const VK_BATCH_LIMIT = 100;

/** VK error_code for rate/flood limiting - retried with backoff. */
export const VK_ERROR_RATE_LIMIT = 9;
/** VK error_codes meaning broken/insufficient auth - per-item errored, never retried. */
export const VK_AUTH_ERROR_CODES: ReadonlySet<number> = new Set([5, 17]);

/** `errored`-list code for auth failures (missing token, VK codes 5/17). */
export const METRICS_AUTH = "metrics_auth" as const;

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface VkCollectorOptions {
  /**
   * VK access token. Defaults to env {@link ENV_VK_TOKEN} resolved at
   * collect() time; src/config.ts exposes the same value as
   * `ServiceConfig.vkToken` for the production wiring.
   */
  token?: string;
  /** fetch implementation (Node 24 global by default); injectable for tests. */
  fetch?: FetchLike;
  /** API base URL, default {@link VK_API_BASE}. */
  apiBase?: string;
  /** VK API version, default {@link VK_API_VERSION}. */
  apiVersion?: string;
  /** Posts per wall.getById call, default {@link VK_BATCH_LIMIT} (max 100). */
  batchSize?: number;
  /** Retries on VK error 9 after the initial attempt, default 3. */
  maxRetries?: number;
  /** Backoff base delay in ms for error-9 retries, default 1000 (x2 per retry). */
  baseDelayMs?: number;
  /** fetch timeout in ms, default 10000. */
  timeoutMs?: number;
  /** Sleep implementation for backoff; injectable so tests don't wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** Post object inside the wall.getById `response.items` array. */
export interface VkWallPost {
  id?: number;
  owner_id?: number;
  views?: { count?: number };
  likes?: { count?: number };
  comments?: { count?: number };
  [key: string]: unknown;
}

interface VkApiErrorBody {
  error_code?: number;
  error_msg?: string;
  [key: string]: unknown;
}

/** Outcome of one wall.getById call (after the error-9 retry loop). */
type BatchResult =
  | { kind: "ok"; posts: VkWallPost[] }
  | { kind: "vk_error"; code: number; message: string }
  | { kind: "upstream"; message: string };

/**
 * Extract the `<owner>_<post>` wall ref from a VK post URL
 * (`https://vk.com/wall29642349_300`, group owners negative:
 * `https://vk.com/wall-123_45`). Tolerates http, www./m. subdomains and
 * trailing path/query fragments; returns null on anything else.
 */
export function parseVkWallRef(url: string): string | null {
  const m = /^https?:\/\/(?:(?:www|m)\.)?vk\.com\/wall(-?\d+_\d+)(?:[/?#].*)?$/i.exec(url.trim());
  return m?.[1] ?? null;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** VK-platform collector; see the module docstring for the error policy. */
export class VkCollector implements PlatformCollector {
  readonly platform = "vk" as const;

  private readonly token?: string;
  private readonly fetchImpl: FetchLike;
  private readonly apiBase: string;
  private readonly apiVersion: string;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: VkCollectorOptions = {}) {
    if (opts.token !== undefined) {
      this.token = opts.token;
    }
    this.fetchImpl = opts.fetch ?? fetch;
    this.apiBase = opts.apiBase ?? VK_API_BASE;
    this.apiVersion = opts.apiVersion ?? VK_API_VERSION;
    this.batchSize = Math.min(Math.max(opts.batchSize ?? VK_BATCH_LIMIT, 1), VK_BATCH_LIMIT);
    this.maxRetries = opts.maxRetries ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async collect(items: readonly ContentItem[], ctx: CollectContext): Promise<CollectOutcome[]> {
    const token = this.resolveToken();
    if (token === undefined) {
      throw new ServiceError(
        METRICS_AUTH,
        "metrics",
        false,
        `${ENV_VK_TOKEN} is not set - cannot run the VK metrics collector`,
      );
    }

    // First parseable wall ref per item wins; extra refs are warned and
    // ignored (a MetricSnapshot keys on item+platform, not per post).
    const refByItem = new Map<string, string>();
    const itemsByRef = new Map<string, string[]>();
    const outcomes: CollectOutcome[] = [];
    for (const item of items) {
      const refs = item.published_urls
        .map((u) => parseVkWallRef(u))
        .filter((r): r is string => r !== null);
      if (refs.length === 0) {
        outcomes.push({
          kind: "skip",
          item_id: item.id,
          reason: "no parseable vk wall url in published_urls",
        });
        continue;
      }
      const ref = refs[0];
      if (refs.length > 1) {
        ctx.warn(
          `vk: item ${item.id}: ${refs.length - 1} extra wall ref(s) ignored ` +
            `(measuring ${ref})`,
        );
      }
      refByItem.set(item.id, ref);
      const list = itemsByRef.get(ref) ?? [];
      list.push(item.id);
      itemsByRef.set(ref, list);
    }

    // Batch the deduped refs, then map batch results back onto items.
    const refResults = new Map<string, BatchResult>();
    const refs = [...itemsByRef.keys()];
    for (const batch of chunk(refs, this.batchSize)) {
      const res = await this.wallGetById(batch, token, ctx);
      for (const ref of batch) {
        refResults.set(ref, res);
      }
    }

    for (const item of items) {
      const ref = refByItem.get(item.id);
      if (ref === undefined) {
        continue; // already has a skip outcome
      }
      const res = refResults.get(ref);
      const apiPost =
        res?.kind === "ok"
          ? res.posts.find((p) => `${p.owner_id ?? ""}_${p.id ?? ""}` === ref)
          : undefined;
      outcomes.push(outcomeFor(item.id, ref, res, apiPost, ctx.now));
    }
    return outcomes;
  }

  /** Token resolution happens at run time, never at import/construct. */
  private resolveToken(): string | undefined {
    const value = this.token ?? process.env[ENV_VK_TOKEN];
    if (value === undefined || value.trim() === "") {
      return undefined;
    }
    return value;
  }

  /**
   * One wall.getById call with the error-9 retry loop. Returns a
   * discriminated {@link BatchResult}; HTTP POST keeps the token out of
   * the URL (query strings leak into logs).
   */
  private async wallGetById(
    posts: readonly string[],
    token: string,
    ctx: CollectContext,
  ): Promise<BatchResult> {
    let attempt = 0;
    for (;;) {
      const res = await this.callOnce(posts, token);
      if (res.kind !== "vk_error" || res.code !== VK_ERROR_RATE_LIMIT) {
        return res;
      }
      if (attempt >= this.maxRetries) {
        ctx.warn(
          `vk: wall.getById still rate-limited (error ${VK_ERROR_RATE_LIMIT}) ` +
            `after ${this.maxRetries} retries - skipping ${posts.length} post(s)`,
        );
        return res;
      }
      const delay = this.baseDelayMs * 2 ** attempt;
      attempt += 1;
      ctx.warn(`vk: rate limited (error ${VK_ERROR_RATE_LIMIT}), retry ${attempt} in ${delay}ms`);
      await this.sleep(delay);
    }
  }

  private async callOnce(posts: readonly string[], token: string): Promise<BatchResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiBase}/wall.getById`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          access_token: token,
          v: this.apiVersion,
          posts: posts.join(","),
        }).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      return { kind: "upstream", message: `fetch failed: ${causeMessage(e)}` };
    }
    if (!res.ok) {
      return { kind: "upstream", message: `HTTP ${res.status} ${res.statusText}` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      return { kind: "upstream", message: `invalid JSON response: ${causeMessage(e)}` };
    }
    if (typeof body !== "object" || body === null) {
      return { kind: "upstream", message: "malformed response: not an object" };
    }
    const err = (body as { error?: VkApiErrorBody }).error;
    if (err !== undefined) {
      return {
        kind: "vk_error",
        code: typeof err.error_code === "number" ? err.error_code : -1,
        message: typeof err.error_msg === "string" ? err.error_msg : JSON.stringify(err),
      };
    }
    const items = (body as { response?: { items?: unknown } }).response?.items;
    if (!Array.isArray(items)) {
      return { kind: "upstream", message: "malformed response: response.items missing" };
    }
    return { kind: "ok", posts: items as VkWallPost[] };
  }
}

function outcomeFor(
  itemId: string,
  ref: string,
  res: BatchResult | undefined,
  apiPost: VkWallPost | undefined,
  now: () => Date,
): CollectOutcome {
  if (res === undefined) {
    return { kind: "skip", item_id: itemId, reason: `post ${ref}: not requested` };
  }
  if (res.kind === "vk_error") {
    if (VK_AUTH_ERROR_CODES.has(res.code)) {
      return {
        kind: "error",
        item_id: itemId,
        code: METRICS_AUTH,
        message: `vk error ${res.code}: ${res.message}`,
      };
    }
    // Rate-limit exhausted and every other VK error: skip, don't fake metrics.
    return {
      kind: "skip",
      item_id: itemId,
      reason: `vk error ${res.code}: ${res.message}`,
    };
  }
  if (res.kind === "upstream") {
    return {
      kind: "error",
      item_id: itemId,
      code: METRICS_UPSTREAM,
      message: `post ${ref}: ${res.message}`,
    };
  }
  if (apiPost === undefined) {
    return {
      kind: "skip",
      item_id: itemId,
      reason: `post ${ref}: not returned by wall.getById (deleted/hidden?)`,
    };
  }
  const snapshot: MetricSnapshot = {
    item_id: itemId,
    platform: "vk",
    ts: now().toISOString(),
    raw: apiPost,
  };
  if (typeof apiPost.views?.count === "number") {
    snapshot.views = apiPost.views.count;
  }
  if (typeof apiPost.likes?.count === "number") {
    snapshot.likes = apiPost.likes.count;
  }
  if (typeof apiPost.comments?.count === "number") {
    snapshot.comments = apiPost.comments.count;
  }
  return { kind: "metric", item_id: itemId, snapshot };
}

function chunk<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) {
    out.push(xs.slice(i, i + size));
  }
  return out;
}
