# pr-manager

AI PR-specialist core for a developer's personal brand. It keeps a unified
content-pipeline state (ingested read-only from the shared_person n8n state
volume), collects own-post metrics (VK `wall.getById`), delivers a periodic
Telegram digest with actionable post briefs and a Send-to-Pipeline loop back
into the n8n content-gen webhook, and flags cadence/pillar drift against a
BrandCharter (`brand.yaml`). A single scheduler daemon drives the three
subsystem ticks; the Express API exposes health, manual triggers and the
Telegram callback intake.

Stack: TypeScript/Express on Node >=24 (`type: module`, NodeNext), SQLite via
better-sqlite3, Vitest for tests, Biome 2.6.4 for lint/format. Always binds
`127.0.0.1:8789` (`PORT` overrides the port, never the loopback bind).

## Architecture

Four subsystems over one SQLite store (`StateStore`, schema-migrated at boot):

- **ingest** (`src/ingest/`) - walks the mounted n8n-state volume
  (`state/drafts/*.json`, `queue/publish/**`, `logs/*.jsonl`), verifies it
  fail-closed via `checkMountHealth` and upserts `ContentItem`s.
- **metrics** (`src/metrics/`) - collects VK `wall.getById` counters for
  published items and stores `MetricSnapshot`s.
- **digest** (`src/digest/`, `src/telegram.ts`, `src/llm.ts`) - summarizes
  pipeline state, asks the llm-gateway `strategist` role for briefs
  (`POST {LLM_GATEWAY_URL}/run`), sends the digest to Telegram with inline
  "Send to Pipeline" buttons, and posts a chosen brief back to
  `{N8N_WEBHOOK_BASE}/webhook/content-gen` when its `pipeline:<rec_id>`
  callback arrives.
- **scheduler** (`src/scheduler.ts`) - one daemon ticks ingest/metrics/digest
  on independent intervals; overlapping same-step ticks are skipped, each
  step races `TICK_STEP_TIMEOUT_MS`, and per-subsystem
  `last_success`/`last_error` surface verbatim through `GET /health`. The
  digest tick composes cadence flags from `brand.yaml` into the outgoing
  message.

```text
n8n state volume (ro mount) --ingest--> SQLite --metrics--> VK wall.getById
                                         |
                                         +--digest--> llm-gateway /run
                                         |            -> Telegram digest + briefs
                                         +--callback `pipeline:<id>`--> n8n /webhook/content-gen
```

## Install & run

```sh
npm ci          # install (Node >= 24)
npm run dev     # dev server (tsx)
npm run build   # tsc -> dist/
npm start       # node dist/server.js
```

**API-only mode:** `N8N_STATE_ROOT` is the only env the scheduler daemon
strictly requires. Starting without it does not crash - the HTTP surface still
serves and `GET /health` answers `ok:true` with `degraded:true` plus a `notice`
in the scheduler section ("api-only mode: missing required env N8N_STATE_ROOT").
Manual ticks answer 503 in this mode. A malformed env (bad port, bad tick
value, unreadable DB path) boots the API in `failed` mode instead:
`/health` answers `ok:false` and carries the error in the scheduler section -
local dev without a full env therefore degrades gracefully to API-only.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `N8N_STATE_ROOT` | - (required for the daemon) | Root of the read-only mounted n8n-state volume; must contain `state/drafts`, `queue/publish`, `logs`. Absent -> api-only mode. |
| `DB_PATH` | `./data/pr_manager.db` | SQLite file for the StateStore; `:memory:` selects an in-memory DB (tests/dev). |
| `PORT` | `8789` | HTTP listen port (1..65535; bind stays `127.0.0.1`). |
| `VK_TOKEN` | unset | VK API access token for the metrics collector. Optional at startup; the metrics tick fails with a clear error when it runs without one. |
| `LLM_GATEWAY_URL` | `http://127.0.0.1:8787` | llm-gateway base URL; the digest calls `POST {url}/run` (role `strategist`). |
| `TG_BOT_TOKEN` | unset | Telegram Bot API token for digest delivery and `answerCallbackQuery`. |
| `TG_CHAT_ID` | unset | Telegram chat the digest is delivered to. A missing token/chat pair degrades the digest tick to a logged skip, never a startup failure. |
| `N8N_WEBHOOK_BASE` | `http://127.0.0.1:5678` | shared_person n8n base URL; Send-to-Pipeline posts to `{base}/webhook/content-gen`. |
| `CONTENT_GEN_WEBHOOK_URL` | unset | Full content-gen webhook URL; overrides `N8N_WEBHOOK_BASE` outright when set. |
| `TICK_INGEST_MS` | `300000` (5 min) | Ingest tick interval; `0` disables auto-scheduling (manual `/tick/ingest` stays live). |
| `TICK_METRICS_MS` | `1800000` (30 min) | Metrics tick interval; `0` disables. |
| `TICK_DIGEST_MS` | `86400000` (24 h) | Digest tick interval; `0` disables. |
| `TICK_STEP_TIMEOUT_MS` | `600000` (10 min) | Hard cap on one step's run time; a step past it records `last_error` "step timeout after Nms" and the running guard clears. `0` disables. |
| `WEBHOOK_SECRET` | unset | Shared secret gating `POST /telegram/callback` and `POST /tick/<step>`: requests must echo it in the `x-telegram-bot-api-secret-token` header or get 403. Unset = open (acceptable only on the loopback bind). |
| `BRAND_CHARTER_PATH` | `./brand.yaml` | BrandCharter path (read by `loadCharter` at digest-tick time, relative to process cwd). A missing/broken charter degrades to a flag-free digest, not a failure. |
| `N8N_STATE_REQUIRE_MOUNT` | unset | `1`/`true` requires `N8N_STATE_ROOT` to be a real mount point (device differs from its parent) - catches an unmounted mountpoint with leftover dirs. |
| `N8N_STATE_SENTINEL` | unset | Name of a marker file that must exist under `N8N_STATE_ROOT` for the mount check to pass. |

## Endpoints

| Route | Behavior |
| --- | --- |
| `GET /health` | `{ok, service:"pr-manager", degraded, subsystems:{ingest, metrics, digest, scheduler}}`; each subsystem is `{last_success, last_error}` (ISO timestamp / last failure message, sticky until replaced). The scheduler section carries `notice` in api-only mode or the boot error when `ok:false`. |
| `GET /state/summary` | `501 {ok:false, error:"not implemented"}` - stub. |
| `POST /audit/run` | `501 {ok:false, error:"not implemented"}` - stub. |
| `POST /tick/{ingest\|metrics\|digest}` | Runs one scheduler step now and returns its `TickResult`; `404` unknown step, `503` when the daemon is not attached (api-only), `500` on step failure. Secret-gated when `WEBHOOK_SECRET` is set. |
| `POST /telegram/callback` | Telegram webhook intake: a `callback_query` with data `pipeline:<rec_id>` routes into `sendToPipeline`; the query is always answered via `answerCallbackQuery` so the client never spins. `503` in api-only mode; secret-gated when `WEBHOOK_SECRET` is set (register the webhook with `secret_token`). |

Unknown routes get a JSON `404`; handler errors a JSON `500`.

## brand.yaml (BrandCharter)

`brand.yaml` at the repo root is the personal-brand contract the cadence
checker scores publish history against. Fields (`src/cadence/charter.ts`
validates eagerly at load):

- `audience` (string, required) - who the brand speaks to.
- `tone` (string, required) - voice guidance.
- `content_pillars` (non-empty list, required) - `{name, objective,
  description?}`; `objective` is one of `authority | proof | community`.
- `cadence` (non-empty list, required) - `{platform, posts_per_week}`;
  `platform` is one of `vk | linkedin | facebook | instagram | youtube`, no
  duplicates. The checker flags a platform when windowed posts fall below
  `floor(posts_per_week * window_days / 7)`.
- `window_days` (positive int, default `14`) - rolling scoring window.
- `thresholds.pillar_imbalance_pct` (`(0, 100]`, default `70`) - share of one
  pillar's posts that triggers a "pillar imbalance" flag.

## Testing & lint

```sh
npm test           # vitest run
npx tsc --noEmit   # typecheck
npx biome ci .     # lint + format check
```

## Deploy

`deploy/docker-compose.yml` carries a minimal compose snippet: the service
built from this repo, the shared n8n storage volume mounted read-only as
`N8N_STATE_ROOT`, and a named volume for `DB_PATH`.

`.devin/` and the roadmap are private working documents of the dev cycle and
are not published (gitignored).
