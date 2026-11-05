/**
 * Unified orchestration daemon (roadmap item_08).
 *
 * One ticker drives the three subsystem steps - `ingest`, `metrics`,
 * `digest` - each on its own cron-like interval from config
 * (TICK_INGEST_MS / TICK_METRICS_MS / TICK_DIGEST_MS; 0 disables
 * automatic scheduling while leaving the manual trigger live). Every
 * tick is recorded per step as `last_success`/`last_error`, surfaced
 * verbatim through `GET /health` (`Scheduler.health()`).
 *
 * Failure policy: a step that throws records `last_error` and the tick
 * returns `{ok:false}` - it never stops, delays or marks the other
 * steps (per-step state is fully independent). Overlapping ticks of
 * the SAME step are skipped (a `running` guard), so a slow ingest can
 * never pile up on itself; different steps may run concurrently.
 *
 * Step timeout: every step races against `stepTimeoutMs` (env
 * TICK_STEP_TIMEOUT_MS, default {@link DEFAULT_STEP_TIMEOUT_MS}). A
 * step still running past the cap is abandoned - the tick records
 * `last_error` "step timeout after Nms" and the running guard clears,
 * so a hang can neither skip every later tick nor hide behind a stale
 * last_success in /health. A timed-out step that resolves late cannot
 * overwrite the recorded timeout (the result write is guarded by a
 * timed-out flag). 0 disables the cap.
 *
 * The digest step composes cadence flags into delivery: the scheduler
 * runs `checkCadence(store, loadCharter())` and wraps the Telegram
 * fetch so the outgoing sendMessage `text` gets the flags section
 * appended via injectFlagsIntoDigest (src/cadence/checker.ts). This is
 * the seam documented by the checker - digest.ts itself has no
 * pre-send hook, so the composition lives here, not in src/digest/.
 * A missing/broken charter or a checker failure degrades to a logged
 * warning and the digest goes out without flags.
 *
 * Telegram callback consumption (POST /telegram/callback) also lives
 * here: `callback_query` updates with data `pipeline:<rec_id>` route
 * into sendToPipeline (src/digest/digest.ts); the query is ALWAYS
 * answered via answerCallbackQuery - even on failure - so the user
 * never sees a stuck spinner.
 *
 * Manual triggers: `tick(name)` is the public entry the HTTP
 * `POST /tick/<step>` route and tests call; timers are injectable
 * (`setIntervalFn`/`clearIntervalFn`) so the daemon is testable
 * without fake-timer magic.
 */

import { loadCharter } from "./cadence/charter.js";
import { type CadenceResult, checkCadence, injectFlagsIntoDigest } from "./cadence/checker.js";
import { ENV_TG_BOT_TOKEN, type ServiceConfig } from "./config.js";
import {
  type DigestResult,
  type PipelineSendResult,
  runDigest,
  type SendToPipelineOptions,
  sendToPipeline,
} from "./digest/digest.js";
import { causeMessage, isServiceError } from "./errors.js";
import type { IngestSource, MountHealthOptions } from "./ingest/contract.js";
import { type IngestRunResult, ingestAll } from "./ingest/runner.js";
import type { FetchLike, LlmClientOptions } from "./llm.js";
import {
  type CollectMetricsOptions,
  collectMetrics,
  type MetricsRunResult,
} from "./metrics/collector.js";
import { VkCollector } from "./metrics/vk.js";
import type { StateStore } from "./store/contract.js";
import {
  DEFAULT_TELEGRAM_TIMEOUT_MS,
  MAX_MESSAGE_CHARS,
  TELEGRAM_API_BASE,
  type TelegramSendOptions,
  type TelegramSendResult,
  TRUNCATED_SUFFIX,
} from "./telegram.js";

/** Subsystem steps the scheduler drives. */
export type StepName = "ingest" | "metrics" | "digest";

export const STEP_NAMES: readonly StepName[] = ["ingest", "metrics", "digest"];

export function isStepName(v: string): v is StepName {
  return (STEP_NAMES as readonly string[]).includes(v);
}

/**
 * Default hard cap on one step's run time (10 min). Production wiring
 * overrides it from `ServiceConfig.stepTimeoutMs` (env
 * TICK_STEP_TIMEOUT_MS); 0 disables the cap.
 */
export const DEFAULT_STEP_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Per-subsystem health view surfaced via `GET /health`. Exactly the
 * {last_success, last_error} shape the health stub promised: an
 * ISO-8601 timestamp of the last successful tick and the message of
 * the last failure (persisting until replaced - a later success does
 * not erase the record of a past error).
 */
export interface SubsystemHealth {
  last_success: string | null;
  last_error: string | null;
}

/** One step's bookkeeping: scheduling interval plus tick history. */
export interface StepState extends SubsystemHealth {
  /** Tick interval in ms; 0 = never auto-scheduled. */
  intervalMs: number;
  /** True while a tick of this step is in flight (overlap guard). */
  running: boolean;
}

/** A step implementation: any async callable; its return value rides back in {@link TickResult.result}. */
export type StepFn = () => Promise<unknown>;

/** Outcome of one {@link Scheduler.tick}; the step never throws through it. */
export interface TickResult {
  ok: boolean;
  step: StepName;
  /** True when the tick was skipped because the step is already running. */
  skipped?: boolean;
  /** Step function return value on success. */
  result?: unknown;
  /** Failure summary on a throwing step (also recorded into health last_error). */
  error?: string;
}

/** callback_data prefix the digest's "Send to Pipeline" button carries. */
export const PIPELINE_CALLBACK_PREFIX = "pipeline:";

/** Options for {@link answerCallbackQuery}. */
export interface AnswerCallbackQueryOptions {
  /** Short text Telegram shows as a toast (<= 200 chars). */
  text?: string;
  /** Bot API token; defaults to env TG_BOT_TOKEN. */
  token?: string;
  /** fetch implementation; injectable for tests. */
  fetch?: FetchLike;
  /** Per-call timeout in ms, default {@link DEFAULT_TELEGRAM_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Log sink for failures; defaults to console.error. */
  log?: (msg: string) => void;
}

/**
 * Telegram `answerCallbackQuery` client - the counterpart src/telegram.ts
 * does not provide (it only knows sendMessage). Same never-throw policy:
 * every failure is logged and reported `{ok:false,error}`.
 */
export async function answerCallbackQuery(
  callbackQueryId: string,
  opts: AnswerCallbackQueryOptions = {},
): Promise<TelegramSendResult> {
  const log = opts.log ?? ((msg: string) => console.error(msg));
  const token = (opts.token ?? process.env[ENV_TG_BOT_TOKEN])?.trim();
  if (token === undefined || token === "") {
    const error = "telegram not configured (TG_BOT_TOKEN missing)";
    log(`[scheduler] answerCallbackQuery skipped: ${error}`);
    return { ok: false, error };
  }

  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TELEGRAM_TIMEOUT_MS;
  const payload: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (opts.text !== undefined) {
    payload.text = opts.text;
  }

  let res: Response;
  try {
    res = await fetchImpl(`${TELEGRAM_API_BASE}/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const error = `telegram answerCallbackQuery transport failure: ${causeMessage(e)}`;
    log(`[scheduler] ${error}`);
    return { ok: false, error };
  }

  let body: { ok?: boolean; description?: string };
  try {
    body = (await res.json()) as { ok?: boolean; description?: string };
  } catch (e) {
    const error = `telegram answerCallbackQuery returned non-JSON body (HTTP ${res.status}): ${causeMessage(e)}`;
    log(`[scheduler] ${error}`);
    return { ok: false, error };
  }
  if (!res.ok || body.ok !== true) {
    const error = `telegram answerCallbackQuery failed (HTTP ${res.status}): ${body.description ?? "unknown"}`;
    log(`[scheduler] ${error}`);
    return { ok: false, error };
  }
  return { ok: true };
}

/** Dependencies {@link handleTelegramUpdate} routes a callback through. */
export interface CallbackDeps {
  store: StateStore;
  /** sendToPipeline POST options (webhook url/base, fetch). */
  pipeline?: SendToPipelineOptions;
  /** Bot token for the default answerCallbackQuery; falls back to env TG_BOT_TOKEN. */
  telegramToken?: string;
  /** fetch for the default answerCallbackQuery. */
  fetch?: FetchLike;
  /** Injectable overrides (tests); default to the real implementations. */
  sendToPipeline?: (
    store: StateStore,
    recId: string,
    opts?: SendToPipelineOptions,
  ) => Promise<PipelineSendResult>;
  answerCallbackQuery?: (
    callbackQueryId: string,
    opts?: AnswerCallbackQueryOptions,
  ) => Promise<TelegramSendResult>;
  log?: (msg: string) => void;
}

/** Outcome of {@link handleTelegramUpdate}. */
export interface CallbackHandleResult {
  /** True when the update carried a callback_query (i.e. we owned it). */
  handled: boolean;
  /**
   * The routed action's success flag (`sendToPipeline.ok`). False when
   * the action failed AND when the callback_query carried a non-empty
   * `data` naming an unsupported action; true only when nothing
   * actionable ran (no callback_query, or an empty `data`).
   */
  ok: boolean;
  /** Action error detail, when any. */
  error?: string;
  /** The toast text delivered via answerCallbackQuery. */
  answer?: string;
}

/**
 * Consume ONE Telegram Update object (POST /telegram/callback body).
 *
 * - `callback_query.data` = `pipeline:<rec_id>` routes into
 *   sendToPipeline; the toast reflects the outcome.
 * - Any other callback data answers with a neutral "unsupported action".
 * - Updates without a callback_query are ignored ({handled:false}).
 *
 * The callback query is ALWAYS answered when it carries an id - a
 * sendToPipeline failure (or even an injected implementation that
 * throws) still produces a toast, never a stuck client spinner.
 * Failures are logged through `deps.log`.
 */
export async function handleTelegramUpdate(
  update: unknown,
  deps: CallbackDeps,
): Promise<CallbackHandleResult> {
  const log = deps.log ?? ((msg: string) => console.error(msg));
  const cq = (update as { callback_query?: unknown } | null | undefined)?.callback_query;
  if (typeof cq !== "object" || cq === null) {
    return { handled: false, ok: true };
  }
  const query = cq as { id?: unknown; data?: unknown };
  const queryId =
    typeof query.id === "string" || typeof query.id === "number" ? String(query.id) : "";
  const data = typeof query.data === "string" ? query.data : "";

  let ok = true;
  let error: string | undefined;
  let answer = "ok";

  if (data.startsWith(PIPELINE_CALLBACK_PREFIX)) {
    const recId = data.slice(PIPELINE_CALLBACK_PREFIX.length);
    const send = deps.sendToPipeline ?? sendToPipeline;
    try {
      const res = await send(deps.store, recId, deps.pipeline);
      ok = res.ok;
      error = res.error;
      answer = res.ok ? "Brief sent to pipeline" : "Send to pipeline failed";
      if (!res.ok) {
        log(`[scheduler] sendToPipeline ${recId}: ${res.error ?? "unknown"}`);
      }
    } catch (e) {
      // sendToPipeline is documented non-throwing; this guards injected
      // implementations - the callback is still answered below.
      ok = false;
      error = causeMessage(e);
      answer = "Send to pipeline failed";
      log(`[scheduler] sendToPipeline ${recId} threw: ${error}`);
    }
  } else if (data !== "") {
    ok = false;
    answer = "unsupported action";
    log(`[scheduler] unsupported callback_query data: ${data}`);
  }

  if (queryId !== "") {
    const answerFn = deps.answerCallbackQuery ?? answerCallbackQuery;
    try {
      const ack = await answerFn(queryId, {
        text: answer,
        token: deps.telegramToken,
        fetch: deps.fetch,
        log,
      });
      if (!ack.ok) {
        log(`[scheduler] answerCallbackQuery failed: ${ack.error ?? "unknown"}`);
      }
    } catch (e) {
      // The spinner cannot be cleared - nothing left to do but log.
      log(`[scheduler] answerCallbackQuery threw: ${causeMessage(e)}`);
    }
  } else {
    log("[scheduler] callback_query without id - cannot answer");
  }

  const result: CallbackHandleResult = { handled: true, ok, answer };
  if (error !== undefined) {
    result.error = error;
  }
  return result;
}

/**
 * Wrap a fetch so outgoing Telegram `sendMessage` calls get the cadence
 * flags section appended to `text` via injectFlagsIntoDigest - the
 * scheduler-side seam for item_07's flag composition (digest.ts exposes
 * no pre-send hook). The combined text is re-capped at
 * MAX_MESSAGE_CHARS so it stays under the Bot API limit after
 * appending. Non-sendMessage calls and non-JSON bodies pass through
 * untouched.
 */
export function cadenceAwareFetch(fetchImpl: FetchLike, cadence: CadenceResult): FetchLike {
  return async (url, init) => {
    if (typeof init?.body === "string" && String(url).endsWith("/sendMessage")) {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (typeof body.text === "string") {
          let text = injectFlagsIntoDigest(body.text, cadence);
          if (text.length > MAX_MESSAGE_CHARS) {
            text = `${text.slice(0, MAX_MESSAGE_CHARS - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`;
          }
          body.text = text;
          init = { ...init, body: JSON.stringify(body) };
        }
      } catch {
        // Not a JSON body - forward it verbatim.
      }
    }
    return fetchImpl(url, init);
  };
}

/** Dependencies the {@link Scheduler} needs beyond the step intervals. */
export interface SchedulerDeps {
  store: StateStore;
  /** Mount root ingestAll reads; required by the default ingest step. */
  stateRoot?: string;
  /** Mount verification options forwarded to ingestAll. */
  mount?: MountHealthOptions;
  /** Ingest sources override; defaults to DEFAULT_INGEST_SOURCES. */
  sources?: readonly IngestSource[];
  /** collectMetrics options (collector set etc.). */
  metrics?: CollectMetricsOptions;
  /** runDigest llm-gateway wiring. */
  llm?: LlmClientOptions;
  /** runDigest Telegram wiring (also supplies the callback answer token). */
  telegram?: TelegramSendOptions;
  /** Digest metric-sample size override. */
  metricsTopN?: number;
  /** sendToPipeline options for callback consumption. */
  pipeline?: SendToPipelineOptions;
  /** BrandCharter path override for the digest cadence section. */
  charterPath?: string;
  /** Per-step implementation overrides (tests); missing names use the defaults. */
  steps?: Partial<Record<StepName, StepFn>>;
  /** Callback-consumption overrides (tests). */
  sendToPipeline?: CallbackDeps["sendToPipeline"];
  answerCallbackQuery?: CallbackDeps["answerCallbackQuery"];
  /** fetch for the default answerCallbackQuery. */
  fetch?: FetchLike;
  /** Timer injection for tests; defaults to the globals. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  /**
   * Hard cap on one step's run time in ms; defaults to
   * {@link DEFAULT_STEP_TIMEOUT_MS}. A step still running past it is
   * abandoned - last_error records "step timeout after Nms" and the
   * running guard clears. 0 disables the cap.
   */
  stepTimeoutMs?: number;
  /** Clock injection for tests; defaults to wall time. */
  now?: () => Date;
  /** Log sink; defaults to console.error. */
  log?: (msg: string) => void;
}

/**
 * The unified service ticker. Construct with per-step intervals
 * (ServiceConfig.tick) and {@link SchedulerDeps}; `start()` arms one
 * timer per step whose intervalMs > 0, `stop()` disarms them. Ticks
 * can also be fired manually via {@link tick} - which is what the
 * `POST /tick/<step>` endpoint calls.
 */
export class Scheduler {
  /** The store the steps (and callback consumption) operate on. */
  readonly store: StateStore;

  private readonly deps: SchedulerDeps;
  private readonly steps: Record<StepName, StepFn>;
  private readonly states: Record<StepName, StepState>;
  private readonly timers = new Map<StepName, ReturnType<typeof setInterval>>();
  private readonly log: (msg: string) => void;
  private readonly now: () => Date;
  private startedAt: string | null = null;

  constructor(intervals: Partial<Record<StepName, number>>, deps: SchedulerDeps) {
    this.deps = deps;
    this.store = deps.store;
    this.log = deps.log ?? ((msg) => console.error(msg));
    this.now = deps.now ?? (() => new Date());
    this.steps = {
      ingest: deps.steps?.ingest ?? (() => this.defaultIngest()),
      metrics: deps.steps?.metrics ?? (() => this.defaultMetrics()),
      digest: deps.steps?.digest ?? (() => this.defaultDigest()),
    };
    this.states = {
      ingest: this.freshState(intervals.ingest),
      metrics: this.freshState(intervals.metrics),
      digest: this.freshState(intervals.digest),
    };
  }

  private freshState(intervalMs: number | undefined): StepState {
    return { intervalMs: intervalMs ?? 0, last_success: null, last_error: null, running: false };
  }

  /**
   * Arm timers for every step whose intervalMs > 0. Each timer fires
   * {@link tick} (fire-and-forget - the tick records its own outcome;
   * the overlap guard inside tick prevents pile-up when a step outlives
   * its interval). A repeated start() while running is a no-op.
   */
  start(): void {
    if (this.startedAt !== null) {
      return;
    }
    this.startedAt = this.now().toISOString();
    const setIv = this.deps.setIntervalFn ?? setInterval;
    for (const name of STEP_NAMES) {
      const intervalMs = this.states[name].intervalMs;
      if (intervalMs <= 0) {
        continue; // 0 disables the step - it stays manual-trigger only
      }
      this.timers.set(
        name,
        setIv(() => {
          void this.tick(name);
        }, intervalMs),
      );
    }
    this.log(
      `[scheduler] started (${STEP_NAMES.map((n) => `${n}=${this.states[n].intervalMs}ms`).join(", ")})`,
    );
  }

  /** Disarm all timers; in-flight ticks finish on their own. */
  stop(): void {
    const clearIv = this.deps.clearIntervalFn ?? clearInterval;
    for (const timer of this.timers.values()) {
      clearIv(timer);
    }
    this.timers.clear();
    this.startedAt = null;
    this.log("[scheduler] stopped");
  }

  /** ISO timestamp of the last start(), or null when not running. */
  startedAtIso(): string | null {
    return this.startedAt;
  }

  /** True while a tick of `name` is in flight. */
  isRunning(name: StepName): boolean {
    return this.states[name].running;
  }

  /** Internal state of one step (interval + tick history + running flag). */
  stepState(name: StepName): StepState {
    return { ...this.states[name] };
  }

  /**
   * The per-subsystem health map `GET /health` serves: exactly
   * {last_success, last_error} per step.
   */
  health(): Record<StepName, SubsystemHealth> {
    const out = {} as Record<StepName, SubsystemHealth>;
    for (const name of STEP_NAMES) {
      const s = this.states[name];
      out[name] = { last_success: s.last_success, last_error: s.last_error };
    }
    return out;
  }

  /**
   * Run one step now (manual trigger + timer entry point). Skips when
   * the same step is already running; on success records last_success,
   * on a throw records last_error - never through to the caller.
   */
  async tick(name: StepName): Promise<TickResult> {
    return this.runStep(name);
  }

  /**
   * {@link tick}'s implementation: overlap guard -> step execution ->
   * health bookkeeping. One step's failure cannot stop or delay the
   * others (each records independently).
   */
  async runStep(name: StepName): Promise<TickResult> {
    const state = this.states[name];
    if (state.running) {
      return { ok: true, step: name, skipped: true };
    }
    state.running = true;
    const timeoutMs = this.deps.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    // A step that outlives stepTimeoutMs is abandoned: the timeout
    // writes last_error and clears `running` (a hung step must not
    // skip every later tick invisibly). `timedOut` also guards the
    // result write - a step that resolves only after the cap must not
    // overwrite the recorded timeout with a late success.
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const stepPromise = this.steps[name]();
      const raced =
        timeoutMs > 0
          ? Promise.race([
              stepPromise,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                  timedOut = true;
                  reject(new Error(`step timeout after ${timeoutMs}ms`));
                }, timeoutMs);
              }),
            ])
          : stepPromise;
      const result = await raced;
      if (timedOut) {
        // The timer already fired but the step's settlement won the
        // race ordering - keep the timeout error, drop the late result.
        throw new Error(`step timeout after ${timeoutMs}ms`);
      }
      state.last_success = this.now().toISOString();
      return { ok: true, step: name, result };
    } catch (e) {
      const error = isServiceError(e)
        ? `${e.code}: ${e.detail ?? causeMessage(e)}`
        : causeMessage(e);
      state.last_error = error;
      this.log(`[scheduler] ${name} tick failed: ${error}`);
      return { ok: false, step: name, error };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      state.running = false;
    }
  }

  /** Route one Telegram Update through {@link handleTelegramUpdate} with this daemon's deps. */
  async handleTelegramUpdate(update: unknown): Promise<CallbackHandleResult> {
    return handleTelegramUpdate(update, {
      store: this.store,
      pipeline: this.deps.pipeline,
      telegramToken: this.deps.telegram?.token,
      fetch: this.deps.fetch,
      sendToPipeline: this.deps.sendToPipeline,
      answerCallbackQuery: this.deps.answerCallbackQuery,
      log: this.log,
    });
  }

  private async defaultIngest(): Promise<IngestRunResult> {
    if (this.deps.stateRoot === undefined || this.deps.stateRoot.trim() === "") {
      throw new Error("ingest step: stateRoot is not configured");
    }
    return ingestAll(this.store, this.deps.stateRoot, this.deps.sources, {
      mount: this.deps.mount,
      now: this.now,
    });
  }

  private async defaultMetrics(): Promise<MetricsRunResult> {
    return collectMetrics(this.store, {
      ...this.deps.metrics,
      now: this.deps.metrics?.now ?? this.now,
    });
  }

  /**
   * Digest tick + cadence composition: checkCadence flags are appended
   * to the outgoing Telegram sendMessage text by wrapping the fetch the
   * digest uses (see {@link cadenceAwareFetch} and the module docstring).
   * Charter/checker failures degrade to a flag-free digest.
   */
  private async defaultDigest(): Promise<DigestResult> {
    return runDigest(this.store, {
      llm: this.deps.llm,
      telegram: this.telegramWithCadence(),
      now: this.now,
      metricsTopN: this.deps.metricsTopN,
      log: this.log,
    });
  }

  private telegramWithCadence(): TelegramSendOptions {
    let cadence: CadenceResult;
    try {
      cadence = checkCadence(this.store, loadCharter(this.deps.charterPath), {
        now: this.now(),
      });
    } catch (e) {
      this.log(
        `[scheduler] cadence check failed, digest goes out without flags: ${causeMessage(e)}`,
      );
      return { ...this.deps.telegram };
    }
    const baseFetch = this.deps.telegram?.fetch ?? fetch;
    return { ...this.deps.telegram, fetch: cadenceAwareFetch(baseFetch, cadence) };
  }
}

/**
 * Build the daemon from a loaded ServiceConfig + migrated store -
 * the production wiring used by server.start(). `overrides` lets tests
 * swap individual deps without re-plumbing the config.
 */
export function createScheduler(
  cfg: ServiceConfig,
  store: StateStore,
  overrides: Partial<Omit<SchedulerDeps, "store">> = {},
): Scheduler {
  return new Scheduler(cfg.tick, {
    store,
    stateRoot: cfg.stateRoot,
    mount: cfg.mountHealth,
    // The VK token comes from the config layer (ServiceConfig.vkToken),
    // not from process.env inside collect(); an explicit `token` option
    // shadows the collector's own env fallback.
    metrics: { collectors: [new VkCollector({ token: cfg.vkToken })] },
    llm: { gatewayUrl: cfg.llmGatewayUrl },
    telegram: { token: cfg.tgBotToken, chatId: cfg.tgChatId },
    pipeline: {
      webhookBase: cfg.n8nWebhookBase,
      webhookUrl: cfg.contentGenWebhookUrl,
    },
    stepTimeoutMs: cfg.stepTimeoutMs,
    ...overrides,
  });
}
