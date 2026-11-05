/**
 * Unified service error taxonomy (roadmap item_03).
 *
 * Every subsystem of the service reports failures in one shape so that
 * callers (scheduler, http layer, digest loop) can log, classify and
 * decide on retries without knowing subsystem internals.
 */

/** Subsystems that produce {@link ServiceError}s. */
export type Subsystem = "ingest" | "metrics" | "digest" | "scheduler" | "http";

export const SUBSYSTEMS: readonly Subsystem[] = [
  "ingest",
  "metrics",
  "digest",
  "scheduler",
  "http",
];

// Well-known error codes. Subsystems may define additional codes, but
// these are the cross-service contract: callers may switch on them.
export const INGEST_UNMOUNTED = "ingest_unmounted" as const;
export const METRICS_UPSTREAM = "metrics_upstream" as const;
export const DIGEST_LLM_DOWN = "digest_llm_down" as const;
export const SCHEDULER_TICK_FAILED = "scheduler_tick_failed" as const;
export const HTTP_BAD_REQUEST = "http_bad_request" as const;

/**
 * Canonical (subsystem, retryable) classification of the well-known
 * codes above. {@link wellKnown} reads from this table so a code can
 * never be emitted with the wrong subsystem or retry flag.
 *
 * Note on retryable: a missing/unreadable mount and a malformed request
 * will not heal by retrying (false); upstream outages, an unavailable
 * LLM and a failed scheduler tick are transient (true).
 */
export const WELL_KNOWN_ERRORS = {
  [INGEST_UNMOUNTED]: { subsystem: "ingest", retryable: false },
  [METRICS_UPSTREAM]: { subsystem: "metrics", retryable: true },
  [DIGEST_LLM_DOWN]: { subsystem: "digest", retryable: true },
  [SCHEDULER_TICK_FAILED]: { subsystem: "scheduler", retryable: true },
  [HTTP_BAD_REQUEST]: { subsystem: "http", retryable: false },
} as const satisfies Record<string, { subsystem: Subsystem; retryable: boolean }>;

export type WellKnownCode = keyof typeof WELL_KNOWN_ERRORS;

/**
 * The one error shape every subsystem throws or returns:
 * {code, subsystem, retryable, detail?} plus a native `.cause`.
 *
 * - `code`: stable machine-readable identifier (a well-known code above
 *   or a subsystem-defined one).
 * - `subsystem`: origin subsystem, one of {@link SUBSYSTEMS}.
 * - `retryable`: whether retrying the same operation may succeed.
 * - `detail`: serialized, human-readable summary of the underlying
 *   failure - the string that survives JSON round-trips across process
 *   boundaries.
 * - `cause`: the standard native Error slot carrying the STRUCTURED
 *   original thrown value (kept via ErrorOptions when wrapping), so a
 *   caller can still inspect upstream fields - e.g. an HTTP status to
 *   tell a retryable 5xx from a fatal 4xx - that `detail` flattens
 *   away. For a deserialized/foreign error `cause` may be absent.
 *
 * It extends Error so it can be thrown normally and still match the
 * documented data shape; {@link isServiceError} is a structural guard,
 * not an instanceof check, so plain shape-conforming objects also
 * qualify (errors routinely cross module and process boundaries).
 */
export class ServiceError extends Error {
  constructor(
    readonly code: string,
    readonly subsystem: Subsystem,
    readonly retryable: boolean,
    detail?: string,
    options?: ErrorOptions,
  ) {
    super(`[${subsystem}] ${code}${detail === undefined ? "" : `: ${detail}`}`, options);
    this.name = "ServiceError";
    if (detail !== undefined) {
      this.detail = detail;
    }
  }

  /** Serialized human-readable summary; the structured original is `.cause`. */
  readonly detail?: string;
}

/** Extract a human-readable cause string from an unknown thrown value. */
export function causeMessage(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  if (typeof e === "string") {
    return e;
  }
  return String(e);
}

/** Construct a {@link ServiceError} with an explicit classification. */
export function makeError(
  code: string,
  subsystem: Subsystem,
  retryable: boolean,
  detail?: string,
): ServiceError {
  return new ServiceError(code, subsystem, retryable, detail);
}

/**
 * Construct a {@link ServiceError} for a well-known code, taking its
 * canonical subsystem and retryable flag from {@link WELL_KNOWN_ERRORS}.
 */
export function wellKnown(code: WellKnownCode, detail?: string): ServiceError {
  const { subsystem, retryable } = WELL_KNOWN_ERRORS[code];
  return new ServiceError(code, subsystem, retryable, detail);
}

/**
 * Structural type guard for the service error shape. Deliberately not
 * `instanceof`: errors may arrive as plain objects across boundaries, so
 * the guard checks the documented serialized fields (and validates
 * `subsystem` against {@link SUBSYSTEMS}). The native `.cause` slot is
 * intentionally unchecked - it holds the original value of any type.
 */
export function isServiceError(e: unknown): e is ServiceError {
  if (typeof e !== "object" || e === null) {
    return false;
  }
  const { code, subsystem, retryable, detail } = e as {
    code?: unknown;
    subsystem?: unknown;
    retryable?: unknown;
    detail?: unknown;
  };
  return (
    typeof code === "string" &&
    typeof subsystem === "string" &&
    (SUBSYSTEMS as readonly string[]).includes(subsystem) &&
    typeof retryable === "boolean" &&
    (detail === undefined || typeof detail === "string")
  );
}

/**
 * Normalize any thrown value into a {@link ServiceError}.
 *
 * If `e` already carries the service-error shape it is re-emitted with
 * its OWN classification - the origin subsystem knows best, so a
 * `metrics_upstream` thrown deep inside the metrics client must not be
 * relabeled by a caller passing different parameters. Otherwise the
 * caller-supplied `opts` classification is used; `opts.retryable` is
 * explicit-by-caller - the wrapper never guesses transience.
 *
 * Whatever was thrown is preserved verbatim on the native `.cause` slot
 * (and summarized into {@link ServiceError.detail}), so callers can
 * still inspect structured upstream fields - e.g. an HTTP status to
 * distinguish a retryable 5xx from a fatal 4xx.
 */
export function wrapError(
  e: unknown,
  opts: { subsystem: Subsystem; code: string; retryable: boolean },
): ServiceError {
  if (e instanceof ServiceError) {
    return e;
  }
  if (isServiceError(e)) {
    // Plain shape-conforming object: re-emit as a real ServiceError,
    // keeping its own classification (see docstring); the observed
    // object itself becomes the native cause.
    return new ServiceError(e.code, e.subsystem, e.retryable, e.detail, { cause: e });
  }
  return new ServiceError(opts.code, opts.subsystem, opts.retryable, causeMessage(e), {
    cause: e,
  });
}
