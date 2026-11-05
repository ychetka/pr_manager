/**
 * Thin llm-gateway client (roadmap item_06).
 *
 * The service owns NO LLM code: every model call goes through the
 * shared_person llm-gateway, which maps a role name onto backend,
 * model, prompt file and context slots (roles/<name>.yaml). This
 * module is a single-endpoint client:
 *
 *   POST {gateway}/run {role, input, system_extra?}
 *     -> {role, model, backend, text}          (text roles)
 *     -> {role, model, backend, json}          (output.type: json roles)
 *
 * The gateway URL comes from opts or env {@link ENV_LLM_GATEWAY_URL}
 * (registered in src/config.ts, default
 * {@link DEFAULT_LLM_GATEWAY_URL}) resolved at CALL time, never at
 * import.
 *
 * Failure policy: any transport error, timeout or non-2xx status is
 * wrapped via wrapError into a "digest_llm_down" ServiceError
 * (subsystem "digest", retryable) - the llm-gateway is this service's
 * only LLM upstream, so its failures are classified under the digest
 * taxonomy. Callers decide whether to degrade (the digest loop falls
 * back to a raw-stats digest) or propagate.
 */
import { DEFAULT_LLM_GATEWAY_URL, ENV_LLM_GATEWAY_URL } from "./config.js";
import { causeMessage, DIGEST_LLM_DOWN, wrapError } from "./errors.js";

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** Default per-call timeout, ~30s per the roadmap. */
export const DEFAULT_LLM_TIMEOUT_MS = 30_000;

/** Request body of `POST {gateway}/run`. */
export interface LlmRunRequest {
  /** Role name from roles/<name>.yaml, e.g. "strategist". */
  role: string;
  /** User-turn input the role's prompt is rendered around. */
  input: string;
  /** Optional text appended to the rendered system prompt. */
  system_extra?: string;
}

/**
 * Response of `POST {gateway}/run`: `text` for free-form roles,
 * `json` for roles whose manifest declares `output.type: json`
 * (parsed, schema-validated, fence-stripped by the gateway).
 */
export interface LlmRunResponse {
  role?: string;
  model?: string;
  backend?: string;
  text?: string;
  json?: unknown;
}

export interface LlmClientOptions {
  /** Gateway base URL; defaults to env LLM_GATEWAY_URL or {@link DEFAULT_LLM_GATEWAY_URL}. */
  gatewayUrl?: string;
  /** fetch implementation (Node global by default); injectable for tests. */
  fetch?: FetchLike;
  /** Per-call timeout in ms, default {@link DEFAULT_LLM_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Resolve the gateway URL at call time (opts > env > default). */
export function resolveGatewayUrl(opts: LlmClientOptions = {}): string {
  return (opts.gatewayUrl ?? process.env[ENV_LLM_GATEWAY_URL])?.trim() || DEFAULT_LLM_GATEWAY_URL;
}

/**
 * POST one role invocation to the llm-gateway and return its body.
 *
 * @throws ServiceError "digest_llm_down" (retryable) on timeout,
 *   transport failure, non-2xx status or a non-JSON body.
 */
export async function runRole(
  req: LlmRunRequest,
  opts: LlmClientOptions = {},
): Promise<LlmRunResponse> {
  const fetchImpl = opts.fetch ?? fetch;
  const base = resolveGatewayUrl(opts).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;

  const body: Record<string, string> = { role: req.role, input: req.input };
  if (req.system_extra !== undefined) {
    body.system_extra = req.system_extra;
  }

  let res: Response;
  try {
    res = await fetchImpl(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw wrapError(e, { subsystem: "digest", code: DIGEST_LLM_DOWN, retryable: true });
  }

  if (!res.ok) {
    throw wrapError(new Error(`llm-gateway /run returned HTTP ${res.status}`), {
      subsystem: "digest",
      code: DIGEST_LLM_DOWN,
      retryable: true,
    });
  }

  try {
    return (await res.json()) as LlmRunResponse;
  } catch (e) {
    throw wrapError(new Error(`llm-gateway /run returned non-JSON body: ${causeMessage(e)}`), {
      subsystem: "digest",
      code: DIGEST_LLM_DOWN,
      retryable: true,
    });
  }
}
