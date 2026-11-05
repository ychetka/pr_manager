import { pathToFileURL } from "node:url";
import express from "express";

const app = express();
app.use(express.json());

// Stub per-subsystem status; real last_success/last_error tracking lands in item_08.
const subsystemStub = () => ({ last_success: null, last_error: null });

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    service: "pr-manager",
    subsystems: {
      ingest: subsystemStub(),
      metrics: subsystemStub(),
      digest: subsystemStub(),
      scheduler: subsystemStub(),
    },
  }),
);

app.get("/state/summary", (_req, res) => res.json({ ok: true, items: 0 }));

app.post("/audit/run", (_req, res) =>
  res.status(501).json({ ok: false, error: "not implemented" }),
);

export { app };

export function start(port = Number(process.env.PORT) || 8789) {
  return app.listen(port, "127.0.0.1", () => {
    console.log(`pr-manager on :${port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
