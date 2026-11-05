import { pathToFileURL } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { loadConfig } from "./config.js";
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

const subsystemStub = () => ({ last_success: null, last_error: null });

app.get("/health", (_req, res) => {
  const h = scheduler?.health();
  res.json({
    ok: true,
    service: "pr-manager",
    subsystems: {
      ingest: h?.ingest ?? subsystemStub(),
      metrics: h?.metrics ?? subsystemStub(),
      digest: h?.digest ?? subsystemStub(),
      scheduler:
        scheduler === null
          ? subsystemStub()
          : { last_success: scheduler.startedAtIso(), last_error: null },
    },
  });
});

// Manual step trigger: POST /tick/{ingest|metrics|digest} runs the step
// now and returns its TickResult (500 when the step itself failed).
app.post("/tick/:step", async (req: Request, res: Response, next: NextFunction) => {
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
});

// Telegram webhook intake: Update objects carrying a callback_query are
// consumed by the scheduler (pipeline:<rec_id> -> sendToPipeline).
app.post("/telegram/callback", async (req: Request, res: Response, next: NextFunction) => {
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
});

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

export function start(port = Number(process.env.PORT) || 8789) {
  // Boot the orchestration daemon when the env config is complete; the
  // API still serves without it (health reports stub subsystems) - a
  // broken mount shows up as ingest's last_error on the first tick
  // rather than taking the HTTP surface down with it.
  try {
    const cfg = loadConfig();
    const store = new SqliteStore(cfg.dbPath);
    store.migrate();
    scheduler = createScheduler(cfg, store);
    scheduler.start();
  } catch (e) {
    console.error(`scheduler daemon not started: ${causeMessage(e)}`);
  }
  return app.listen(port, "127.0.0.1", () => {
    console.log(`pr-manager on :${port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
