import { pathToFileURL } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { ENV_STATE_ROOT, ENV_WEBHOOK_SECRET, loadConfig } from "./config.js";
import { causeMessage } from "./errors.js";
import { createScheduler, isStepName, type Scheduler } from "./scheduler.js";
import { SqliteStore } from "./store/sqlite.js";

const app = express();
app.use(express.json());

// The orchestration daemon (item_08): wired by start() in production or
// by tests via attachScheduler. /health falls back to per-subsystem
// stubs while no scheduler is attached.
let scheduler: Scheduler | null = null;

export function attachScheduler(s: Scheduler | null): void {
  scheduler = s;
}

/**
 * Why the scheduler daemon is not running, split by cause: `error` is
 * a REAL startup failure (loadConfig/store/scheduler construction
 * threw - /health answers ok:false and carries it in the scheduler
 * section); `notice` is the expected API-only degrade (required env
 * absent - the HTTP surface intentionally still serves). bootScheduler
 * rewrites both on every call.
 */
interface StartupDiagnostics {
  error: string | null;
  notice: string | null;
}

let startup: StartupDiagnostics = { error: null, notice: null };

/** Reset startup diagnostics (test hygiene; bootScheduler rewrites them anyway). */
export function resetStartupDiagnostics(): void {
  startup = { error: null, notice: null };
}

/**
 * Telegram's official webhook secret-token header - also the shared
 * secret for POST /tick/<step> when WEBHOOK_SECRET is configured.
 */
export const WEBHOOK_SECRET_HEADER = "x-telegram-bot-api-secret-token";

/**
 * Shared secret gating the inbound webhook surface (env
 * WEBHOOK_SECRET via ServiceConfig.webhookSecret in production,
 * setWebhookSecret in tests). `undefined` keeps the endpoints open -
 * acceptable only because the service binds 127.0.0.1; set the env to
 * expose them beyond localhost.
 */
let webhookSecret: string | undefined;

export function setWebhookSecret(secret: string | undefined): void {
  const trimmed = secret?.trim();
  webhookSecret = trimmed === "" ? undefined : trimmed;
}

/**
 * Optional shared-secret gate for POST /telegram/callback and
 * POST /tick/<step>: with a secret configured, a request must echo it
 * in {@link WEBHOOK_SECRET_HEADER} or it is rejected 403 before any
 * handler runs (a forged pipeline:<rec_id> must never reach
 * sendToPipeline). With no secret the request passes through
 * (localhost-open default).
 */
function requireWebhookSecret(req: Request, res: Response, next: NextFunction): void {
  if (webhookSecret === undefined) {
    next();
    return;
  }
  if (req.get(WEBHOOK_SECRET_HEADER) !== webhookSecret) {
    res.status(403).json({ ok: false, error: "invalid or missing webhook secret" });
    return;
  }
  next();
}

const subsystemStub = () => ({ last_success: null, last_error: null });

app.get("/health", (_req, res) => {
  const h = scheduler?.health();
  const degraded = startup.error !== null || startup.notice !== null;
  res.json({
    ok: startup.error === null,
    service: "pr-manager",
    degraded,
    subsystems: {
      ingest: h?.ingest ?? subsystemStub(),
      metrics: h?.metrics ?? subsystemStub(),
      digest: h?.digest ?? subsystemStub(),
      scheduler:
        scheduler === null
          ? {
              last_success: null,
              last_error: startup.error,
              ...(startup.notice !== null ? { notice: startup.notice } : {}),
            }
          : { last_success: scheduler.startedAtIso(), last_error: startup.error },
    },
  });
});

// Manual step trigger: POST /tick/{ingest|metrics|digest} runs the step
// now and returns its TickResult (500 when the step itself failed).
// Gated by the optional webhook secret like /telegram/callback - a
// manual ingest/metrics/digest trigger is not for the open internet.
app.post(
  "/tick/:step",
  requireWebhookSecret,
  async (req: Request, res: Response, next: NextFunction) => {
    const step = req.params.step;
    if (!isStepName(step)) {
      res.status(404).json({ ok: false, error: `unknown step: ${step}` });
      return;
    }
    if (scheduler === null) {
      res.status(503).json({ ok: false, error: "scheduler not attached" });
      return;
    }
    try {
      const result = await scheduler.tick(step);
      if (!result.ok) {
        res.status(500).json({ ok: false, step: result.step, error: result.error });
        return;
      }
      res.json({
        ok: true,
        step: result.step,
        skipped: result.skipped === true,
        result: result.result,
      });
    } catch (e) {
      next(e);
    }
  },
);

// Telegram webhook intake: Update objects carrying a callback_query are
// consumed by the scheduler (pipeline:<rec_id> -> sendToPipeline). When
// WEBHOOK_SECRET is set, Telegram must be registered with the matching
// secret_token so it arrives in the x-telegram-bot-api-secret-token
// header; anything without it is a forgery and gets 403.
app.post(
  "/telegram/callback",
  requireWebhookSecret,
  async (req: Request, res: Response, next: NextFunction) => {
    if (scheduler === null) {
      res.status(503).json({ ok: false, error: "scheduler not attached" });
      return;
    }
    try {
      const outcome = await scheduler.handleTelegramUpdate(req.body);
      res.json(outcome);
    } catch (e) {
      next(e);
    }
  },
);

app.get("/state/summary", (_req, res) =>
  res.status(501).json({ ok: false, error: "not implemented" }),
);

app.post("/audit/run", (_req, res) =>
  res.status(501).json({ ok: false, error: "not implemented" }),
);

// JSON 404 instead of Express's HTML default.
app.use((_req: Request, res: Response) => res.status(404).json({ ok: false, error: "not found" }));

// JSON error middleware instead of Express's HTML default.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ ok: false, error: "internal" });
});

export { app };

export type BootMode = "running" | "api_only" | "failed";

/**
 * Boot the orchestration daemon from env config (server start; tests
 * call it with a fake env map). Three outcomes, all recorded into
 * `startup` so /health can show them instead of degrading invisibly:
 *
 * - required env absent -> "api_only": the HTTP surface intentionally
 *   still serves, /health stays ok:true but flags degraded + a notice
 *   in the scheduler section;
 * - loadConfig()/store/scheduler threw -> "failed": a real config
 *   error - /health answers ok:false with the error in the scheduler
 *   section;
 * - otherwise -> "running".
 *
 * The webhook secret is applied before the env check so the gate holds
 * even in degraded modes.
 */
export function bootScheduler(env: NodeJS.ProcessEnv = process.env): {
  mode: BootMode;
  detail: string | null;
} {
  setWebhookSecret(env[ENV_WEBHOOK_SECRET]);

  const missing = [ENV_STATE_ROOT].filter(
    (name) => env[name] === undefined || env[name].trim() === "",
  );
  if (missing.length > 0) {
    const notice = `api-only mode: missing required env ${missing.join(", ")} - scheduler daemon not started`;
    startup = { error: null, notice };
    console.error(notice);
    return { mode: "api_only", detail: notice };
  }
  try {
    const cfg = loadConfig(env);
    const store = new SqliteStore(cfg.dbPath);
    store.migrate();
    scheduler = createScheduler(cfg, store);
    scheduler.start();
    startup = { error: null, notice: null };
    return { mode: "running", detail: null };
  } catch (e) {
    const error = causeMessage(e);
    startup = { error, notice: null };
    console.error(`scheduler daemon not started: ${error}`);
    return { mode: "failed", detail: error };
  }
}

export function start(port = Number(process.env.PORT) || 8789) {
  // Boot the orchestration daemon when the env config is complete; the
  // API still serves without it (health reports the failure instead of
  // hiding it) - a broken mount shows up as ingest's last_error on the
  // first tick rather than taking the HTTP surface down with it.
  bootScheduler();
  return app.listen(port, "127.0.0.1", () => {
    console.log(`pr-manager on :${port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
