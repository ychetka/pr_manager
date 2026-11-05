/**
 * Digest pipeline + Send-to-Pipeline loop (roadmap item_06).
 *
 * {@link runDigest} gathers a state summary from the store (counts by
 * status and platform, fresh metric samples, objective distribution),
 * hands it to the llm-gateway "strategist" role and delivers the
 * resulting digest to Telegram with an inline "Send to Pipeline"
 * button per recommended brief. Each brief is persisted as a
 * Recommendation (status "proposed"); the button's callback_data is
 * `pipeline:<rec_id>` so a callback handler can route it into
 * {@link sendToPipeline}. Consuming the callback_query update itself
 * is wired in item_08 - this module owns the button payload and the
 * entry point it routes to.
 *
 * {@link sendToPipeline} posts the recommendation back to the
 * shared_person intake - `POST {N8N_WEBHOOK_BASE}/webhook/content-gen`
 * (or the full {@link ENV_CONTENT_GEN_WEBHOOK_URL} override) - whose
 * brief gate requires `context` >= 200 chars with >= 2 digit-bearing
 * tokens; the serialized brief carries an ISO timestamp and a
 * digit-bearing recommendation id to satisfy it. On a 2xx the
 * recommendation moves proposed -> sent via updateRecommendationStatus.
 * This is the closed loop: measured > recommended > ordered post.
 *
 * Degradation policy (documented roadmap behavior): a llm-gateway
 * outage never fails the tick - the raw stats summary is sent as the
 * digest with zero briefs. Telegram delivery failures are logged and
 * reported via {@link DigestResult} (`sent:false`, `error`); nothing
 * here throws into the caller's face.
 */
import {
  DEFAULT_N8N_WEBHOOK_BASE,
  ENV_CONTENT_GEN_WEBHOOK_URL,
  ENV_N8N_WEBHOOK_BASE,
} from "../config.js";
import { causeMessage, isServiceError } from "../errors.js";
import { type FetchLike, type LlmClientOptions, runRole } from "../llm.js";
import {
  type ContentItem,
  type ContentStatus,
  type MetricSnapshot,
  type Objective,
  PLATFORMS,
  type Platform,
  type Recommendation,
  type RecommendationStatus,
} from "../model/contract.js";
import type { StateStore } from "../store/contract.js";
import { sendMessage, type TelegramSendOptions } from "../telegram.js";

/** llm-gateway role the digest delegates synthesis to. */
export const STRATEGIST_ROLE = "strategist";

/** How many recent published/measured items contribute a metric sample. */
export const DEFAULT_METRICS_TOP_N = 5;

/** Max briefs kept from a strategist response (the prompt asks for 2-3). */
export const MAX_BRIEFS = 3;

/** Default Send-to-Pipeline POST timeout. */
export const DEFAULT_PIPELINE_TIMEOUT_MS = 15_000;

/** A concrete post brief the strategist recommends (one Recommendation). */
export interface DigestBrief {
  topic: string;
  objective: Objective;
  platform: Platform;
}

/** Outcome of one {@link runDigest} tick; never throws. */
export interface DigestResult {
  /** Telegram accepted the digest message. */
  sent: boolean;
  /** The strategist role produced the digest text (false = raw-stats fallback). */
  llm_used: boolean;
  /** Number of actionable briefs emitted (0 on the raw-stats fallback). */
  briefs: number;
  /** Ids of the Recommendations persisted this run (parallel to briefs). */
  recommendations: string[];
  /** First failure worth surfacing (llm and/or telegram), if any. */
  error?: string;
}

/** Outcome of {@link sendToPipeline}; never throws. */
export interface PipelineSendResult {
  ok: boolean;
  error?: string;
  /** The rec's status at the gate, present when `error` is "invalid_status". */
  status?: RecommendationStatus;
}

export interface RunDigestOptions {
  /** llm-gateway client wiring (url/fetch/timeout) - injectable for tests. */
  llm?: LlmClientOptions;
  /** Telegram delivery wiring (token/chat/fetch) - injectable for tests. */
  telegram?: TelegramSendOptions;
  /** Clock injection for tests; defaults to wall time. */
  now?: () => Date;
  /** Recent published/measured items sampled for metrics, default {@link DEFAULT_METRICS_TOP_N}. */
  metricsTopN?: number;
  /** Log sink for failures; defaults to console.error. */
  log?: (msg: string) => void;
}

export interface SendToPipelineOptions {
  /** Full webhook URL; defaults to env CONTENT_GEN_WEBHOOK_URL or `{N8N_WEBHOOK_BASE}/webhook/content-gen`. */
  webhookUrl?: string;
  /** n8n base used when neither webhookUrl nor CONTENT_GEN_WEBHOOK_URL is set. */
  webhookBase?: string;
  /** fetch implementation (Node global by default); injectable for tests. */
  fetch?: FetchLike;
  /** POST timeout in ms, default {@link DEFAULT_PIPELINE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Log sink for failures; defaults to console.error. */
  log?: (msg: string) => void;
}

const ALL_STATUSES: readonly ContentStatus[] = [
  "idea",
  "brief",
  "draft",
  "moderation",
  "approved",
  "queued",
  "published",
  "measured",
  "failed",
  "rejected",
];

const OBJECTIVES: readonly Objective[] = ["authority", "proof", "community"];

/**
 * Requested response shape, passed as system_extra so the strategist's
 * plain-text role still returns machine-readable output. Parsing stays
 * defensive - a text-only reply is a valid digest with zero briefs.
 */
const STRATEGIST_SYSTEM_EXTRA = [
  "You are the pr_manager digest strategist. The input is a state summary",
  "of the personal-brand content pipeline. Respond with STRICT JSON ONLY",
  '(no prose, no markdown fences): {"digest": "<the digest text, ending',
  'with the briefs>", "briefs": [{"topic": "<post subject>", "objective":',
  '"authority|proof|community", "platform": "vk|linkedin|facebook|',
  'instagram|youtube"}]}. Emit 2-3 concrete post briefs grounded in the',
  "summary (platform gaps, missing objectives, measured posts worth a",
  "follow-up).",
].join(" ");

interface PipelineStats {
  countsByStatus: Record<ContentStatus, number>;
  countsByPlatform: Record<Platform, number>;
  countsByObjective: Record<Objective, number>;
  metricSamples: { item: ContentItem; snap: MetricSnapshot }[];
  total: number;
}

/**
 * Gather the digest's factual basis: per-status counts (one getByStatus
 * per status), per-platform and per-objective distributions over every
 * stored item, and the latest metric snapshot of the `topN` most
 * recently updated published/measured items.
 */
export function gatherStats(store: StateStore, topN = DEFAULT_METRICS_TOP_N): PipelineStats {
  const countsByStatus = {} as Record<ContentStatus, number>;
  const countsByPlatform = {} as Record<Platform, number>;
  const countsByObjective = {} as Record<Objective, number>;
  for (const p of PLATFORMS) {
    countsByPlatform[p] = 0;
  }
  for (const o of OBJECTIVES) {
    countsByObjective[o] = 0;
  }

  const items: ContentItem[] = [];
  for (const status of ALL_STATUSES) {
    const inStatus = store.getByStatus(status);
    countsByStatus[status] = inStatus.length;
    items.push(...inStatus);
  }

  for (const item of items) {
    for (const p of item.platform_refs) {
      countsByPlatform[p] += 1;
    }
    countsByObjective[item.objective] += 1;
  }

  const metricSamples: { item: ContentItem; snap: MetricSnapshot }[] = items
    .filter((item) => item.status === "published" || item.status === "measured")
    .sort((a, b) => b.timestamps.updated_at.localeCompare(a.timestamps.updated_at))
    .slice(0, topN)
    .flatMap((item) => {
      const snaps = store.metricsFor(item.id);
      const snap = snaps.at(-1);
      return snap === undefined ? [] : [{ item, snap }];
    });

  return {
    countsByStatus,
    countsByPlatform,
    countsByObjective,
    metricSamples,
    total: items.length,
  };
}

/** Render the gathered stats as the digest's raw-text fallback / strategist input. */
export function formatRawDigest(stats: PipelineStats, nowIso: string): string {
  const statusLine = ALL_STATUSES.map((s) => `${s}=${stats.countsByStatus[s]}`).join(" ");
  const platformLine = PLATFORMS.map((p) => `${p}=${stats.countsByPlatform[p]}`).join(" ");
  const objectiveLine = OBJECTIVES.map((o) => `${o}=${stats.countsByObjective[o]}`).join(" ");
  const lines = [
    `PR Manager digest - ${nowIso}`,
    `Pipeline (${stats.total} items): ${statusLine}`,
    `Platforms: ${platformLine}`,
    `Objectives: ${objectiveLine}`,
  ];
  if (stats.metricSamples.length === 0) {
    lines.push("Recent metrics: none");
  } else {
    lines.push("Recent metrics:");
    for (const { item, snap } of stats.metricSamples) {
      const parts = [`views=${snap.views ?? "-"}`, `likes=${snap.likes ?? "-"}`];
      parts.push(`comments=${snap.comments ?? "-"}`);
      lines.push(`- ${item.id} (${snap.platform}) ${snap.ts}: ${parts.join(" ")}`);
    }
  }
  return lines.join("\n");
}

function isObjective(v: unknown): v is Objective {
  return typeof v === "string" && (OBJECTIVES as readonly string[]).includes(v);
}

function isPlatform(v: unknown): v is Platform {
  return typeof v === "string" && (PLATFORMS as readonly string[]).includes(v);
}

/** Keep only structurally valid briefs, capped at {@link MAX_BRIEFS}. */
function parseBriefs(v: unknown): DigestBrief[] {
  if (!Array.isArray(v)) {
    return [];
  }
  const briefs: DigestBrief[] = [];
  for (const b of v) {
    if (typeof b !== "object" || b === null) {
      continue;
    }
    const { topic, objective, platform } = b as Record<string, unknown>;
    if (
      typeof topic === "string" &&
      topic.trim() !== "" &&
      isObjective(objective) &&
      isPlatform(platform)
    ) {
      briefs.push({ topic: topic.trim(), objective, platform });
    }
  }
  return briefs.slice(0, MAX_BRIEFS);
}

/**
 * Defensive strategist-response parse: a `json` payload shaped like
 * {digest, briefs[]} wins; otherwise a `text` body is tried as JSON
 * (models sometimes answer the JSON shape in text roles anyway) and
 * finally used verbatim as the digest with zero briefs.
 */
export function parseStrategistResponse(res: { text?: string; json?: unknown }): {
  digest: string;
  briefs: DigestBrief[];
} {
  if (typeof res.json === "object" && res.json !== null) {
    const j = res.json as Record<string, unknown>;
    return {
      digest: typeof j.digest === "string" ? j.digest : "",
      briefs: parseBriefs(j.briefs),
    };
  }
  const text = res.text ?? "";
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const j: unknown = JSON.parse(trimmed);
      if (typeof j === "object" && j !== null) {
        const o = j as Record<string, unknown>;
        if (typeof o.digest === "string" || Array.isArray(o.briefs)) {
          return {
            digest: typeof o.digest === "string" ? o.digest : "",
            briefs: parseBriefs(o.briefs),
          };
        }
      }
    } catch {
      // not JSON after all - fall through to verbatim text
    }
  }
  return { digest: text, briefs: [] };
}

/** Deterministic recommendation id: `rec-<compact-iso>-<n>`; digits ride along for the webhook gate. */
export function recommendationId(nowIso: string, index: number): string {
  const stamp = nowIso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `rec-${stamp}-${index + 1}`;
}

/**
 * Run one digest tick. Returns a {@link DigestResult} describing what
 * was sent and persisted; subsystem failures degrade or log instead
 * of throwing (see the module docstring). A store failure during
 * stats gathering ends the tick early with `{sent:false, error}` -
 * the digest dies gracefully, never throws.
 */
export async function runDigest(
  store: StateStore,
  opts: RunDigestOptions = {},
): Promise<DigestResult> {
  const log = opts.log ?? ((msg: string) => console.error(msg));
  const now = opts.now?.() ?? new Date();
  const nowIso = now.toISOString();

  let stats: PipelineStats;
  try {
    stats = gatherStats(store, opts.metricsTopN ?? DEFAULT_METRICS_TOP_N);
  } catch (e) {
    // Store failure: without the factual basis there is no digest to
    // send - log and report the dead tick instead of throwing into it.
    const err = causeMessage(e);
    log(`[digest] stats gathering failed, skipping tick: ${err}`);
    return {
      sent: false,
      llm_used: false,
      briefs: 0,
      recommendations: [],
      error: `store: ${err}`,
    };
  }
  const rawDigest = formatRawDigest(stats, nowIso);

  let digestText = rawDigest;
  let briefs: DigestBrief[] = [];
  let llmUsed = false;
  const errors: string[] = [];

  try {
    const res = await runRole(
      { role: STRATEGIST_ROLE, input: rawDigest, system_extra: STRATEGIST_SYSTEM_EXTRA },
      opts.llm,
    );
    const parsed = parseStrategistResponse(res);
    if (parsed.digest.trim() === "" && parsed.briefs.length === 0) {
      throw new Error("strategist returned an empty response");
    }
    digestText = parsed.digest.trim() === "" ? rawDigest : parsed.digest;
    briefs = parsed.briefs;
    llmUsed = true;
  } catch (e) {
    // llm-gateway down / unusable response: degrade to the raw-stats
    // digest - the tick must still deliver (roadmap behavior).
    const err = isServiceError(e) ? `${e.code}: ${e.detail ?? causeMessage(e)}` : causeMessage(e);
    errors.push(`llm: ${err}`);
    log(`[digest] strategist unavailable, sending raw digest: ${err}`);
  }

  const recIds: string[] = [];
  briefs.forEach((brief, i) => {
    const rec: Recommendation = {
      id: recommendationId(nowIso, i),
      ts: nowIso,
      topic: brief.topic,
      objective: brief.objective,
      platform: brief.platform,
      status: "proposed",
    };
    try {
      store.appendRecommendation(rec);
      recIds.push(rec.id);
    } catch (e) {
      // A colliding id on a terminal-status rec must not kill delivery.
      const err = causeMessage(e);
      errors.push(`recommendation ${rec.id}: ${err}`);
      log(`[digest] failed to persist ${rec.id}: ${err}`);
    }
  });

  const tg = await sendMessage(digestText, {
    ...opts.telegram,
    inlineKeyboard: recIds.map((id) => [
      { text: "Send to Pipeline", callback_data: `pipeline:${id}` },
    ]),
    log,
  });
  if (!tg.ok) {
    errors.push(`telegram: ${tg.error ?? "unknown"}`);
  }

  const result: DigestResult = {
    sent: tg.ok,
    llm_used: llmUsed,
    briefs: briefs.length,
    recommendations: recIds,
  };
  if (errors.length > 0) {
    result.error = errors.join("; ");
  }
  return result;
}

/**
 * Serialize a Recommendation into the `context` string the
 * shared_person content-gen gate accepts: a JSON brief well over 200
 * chars carrying >= 2 digit-bearing tokens (the ISO `proposed_at`
 * timestamp and the digit-bearing recommendation id).
 */
export function serializeBriefContext(rec: Recommendation): string {
  return JSON.stringify({
    kind: "pr_manager_recommendation",
    source_type: "session",
    recommendation_id: rec.id,
    proposed_at: rec.ts,
    topic: rec.topic,
    objective: rec.objective,
    platform: rec.platform,
    platform_fit: [rec.platform],
    facts: [
      `Recommendation ${rec.id} proposed by the pr_manager digest at ${rec.ts}.`,
      `Target pillar: ${rec.objective}; target platform: ${rec.platform}.`,
    ],
    retro: false,
    author_notes:
      "Strategist brief from the pr_manager digest; expand facts against project material before drafting.",
  });
}

/**
 * POST a stored recommendation to the shared_person content-gen
 * webhook and, on a 2xx, move it proposed -> sent.
 *
 * Dedupe/idempotency: only a rec whose CURRENT status is "proposed"
 * may be ordered - a double-click or retry on a sent/dismissed rec
 * returns `{ok:false, error:"invalid_status", status}` WITHOUT a
 * network call, so a content-gen order is never duplicated. The
 * single upfront read is fresh enough to gate on; the rec is
 * re-fetched after the POST for the status flip.
 *
 * Any failure (missing rec, lookup error, transport error, non-2xx)
 * is logged and returned as `{ok:false,error}` with the
 * recommendation untouched - never thrown. A status-update failure
 * AFTER a successful POST (InvalidTransition/NotFound, a store I/O
 * error) is a logged "sent but status update failed" warning with
 * `{ok:true}`: the order was honestly placed.
 */
export async function sendToPipeline(
  store: StateStore,
  recId: string,
  opts: SendToPipelineOptions = {},
): Promise<PipelineSendResult> {
  const log = opts.log ?? ((msg: string) => console.error(msg));

  let rec: Recommendation | undefined;
  try {
    rec = store.listRecommendations().find((r) => r.id === recId);
  } catch (e) {
    const error = `recommendation lookup failed: ${causeMessage(e)}`;
    log(`[digest] sendToPipeline ${recId}: ${error}`);
    return { ok: false, error };
  }
  if (rec === undefined) {
    const error = `recommendation not found: ${recId}`;
    log(`[digest] sendToPipeline skipped: ${error}`);
    return { ok: false, error };
  }

  // Idempotency gate: anything but "proposed" means this rec was
  // already ordered (sent/accepted) or closed out (dismissed) - do
  // NOT fire another content-gen POST for it.
  if (rec.status !== "proposed") {
    const error = "invalid_status";
    log(`[digest] sendToPipeline ${recId}: ${error} (status=${rec.status}), skipping POST`);
    return { ok: false, error, status: rec.status };
  }

  const webhookBase = (
    (opts.webhookBase ?? process.env[ENV_N8N_WEBHOOK_BASE])?.trim() || DEFAULT_N8N_WEBHOOK_BASE
  ).replace(/\/+$/, "");
  const webhookUrl =
    (opts.webhookUrl ?? process.env[ENV_CONTENT_GEN_WEBHOOK_URL])?.trim() ||
    `${webhookBase}/webhook/content-gen`;

  const context = serializeBriefContext(rec);
  const payload = {
    context,
    scope: `Post about "${rec.topic}" for ${rec.platform}; pillar: ${rec.objective}.`,
    accents: [`objective:${rec.objective}`, `platform:${rec.platform}`],
  };

  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PIPELINE_TIMEOUT_MS;

  let res: Response;
  try {
    res = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const error = `content-gen webhook transport failure: ${causeMessage(e)}`;
    log(`[digest] sendToPipeline ${recId}: ${error}`);
    return { ok: false, error };
  }
  if (!res.ok) {
    const error = `content-gen webhook returned HTTP ${res.status}`;
    log(`[digest] sendToPipeline ${recId}: ${error}`);
    return { ok: false, error };
  }

  // The POST already ordered the brief; the status flip below is
  // bookkeeping and MUST NOT throw out of this non-throwing function.
  // Re-fetch the rec fresh - it may have moved while the request was
  // in flight - then flip proposed -> sent. A lifecycle/store failure
  // (NotFound, InvalidTransition, I/O) degrades to a logged warning:
  // `{ok:true}` is the honest outcome because the order was placed.
  try {
    const fresh = store.listRecommendations().find((r) => r.id === recId);
    if (fresh === undefined) {
      throw new Error("recommendation vanished after delivery");
    }
    if (fresh.status !== "sent") {
      // "proposed" flips cleanly; a terminal status (accepted /
      // dismissed) makes the store throw InvalidTransition, which is
      // reported by the catch below as a post-send warning.
      store.updateRecommendationStatus(recId, "sent");
    }
  } catch (e) {
    log(`[digest] sendToPipeline ${recId}: sent but status update failed - ${causeMessage(e)}`);
  }
  log(`[digest] sendToPipeline ${recId}: brief delivered to ${webhookUrl}`);
  return { ok: true };
}
