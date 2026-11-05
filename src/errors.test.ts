import { describe, expect, it } from "vitest";
import {
  causeMessage,
  DIGEST_LLM_DOWN,
  HTTP_BAD_REQUEST,
  INGEST_UNMOUNTED,
  isServiceError,
  METRICS_UPSTREAM,
  makeError,
  SCHEDULER_TICK_FAILED,
  ServiceError,
  SUBSYSTEMS,
  WELL_KNOWN_ERRORS,
  wellKnown,
  wrapError,
} from "./errors.js";

describe("ServiceError shape", () => {
  it("makeError produces the documented {code, subsystem, retryable, detail} shape", () => {
    const err = makeError("custom_code", "digest", true, "boom");

    expect(err).toBeInstanceOf(ServiceError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("custom_code");
    expect(err.subsystem).toBe("digest");
    expect(err.retryable).toBe(true);
    expect(err.detail).toBe("boom");
    expect(err.cause).toBeUndefined(); // native slot: nothing wrapped
    expect(err.message).toContain("custom_code");
    expect(err.message).toContain("boom");
  });

  it("covers all five subsystems", () => {
    expect(SUBSYSTEMS).toEqual(["ingest", "metrics", "digest", "scheduler", "http"]);
  });

  it("well-known codes carry their canonical subsystem + retryable", () => {
    const cases = [
      [INGEST_UNMOUNTED, "ingest", false],
      [METRICS_UPSTREAM, "metrics", true],
      [DIGEST_LLM_DOWN, "digest", true],
      [SCHEDULER_TICK_FAILED, "scheduler", true],
      [HTTP_BAD_REQUEST, "http", false],
    ] as const;

    for (const [code, subsystem, retryable] of cases) {
      expect(WELL_KNOWN_ERRORS[code].subsystem).toBe(subsystem);
      expect(WELL_KNOWN_ERRORS[code].retryable).toBe(retryable);

      const err = wellKnown(code, "detail");
      expect(err.code).toBe(code);
      expect(err.subsystem).toBe(subsystem);
      expect(err.retryable).toBe(retryable);
      expect(err.detail).toBe("detail");
    }
  });
});

describe("isServiceError", () => {
  it("roundtrips makeError / wellKnown output", () => {
    expect(isServiceError(makeError("x", "ingest", false))).toBe(true);
    expect(isServiceError(wellKnown(METRICS_UPSTREAM))).toBe(true);
  });

  it("accepts a plain object carrying the shape", () => {
    expect(
      isServiceError({ code: "c", subsystem: "metrics", retryable: true, detail: "why" }),
    ).toBe(true);
    expect(isServiceError({ code: "c", subsystem: "ingest", retryable: false })).toBe(true);
    // native .cause carries a value of ANY type - the guard does not constrain it
    expect(isServiceError({ code: "c", subsystem: "ingest", retryable: false, cause: 3 })).toBe(
      true,
    );
  });

  it("rejects non-matching values", () => {
    const bad = [
      null,
      undefined,
      "err",
      42,
      new Error("plain"),
      { code: "c" },
      { code: "c", subsystem: "nope", retryable: true },
      { code: 7, subsystem: "ingest", retryable: true },
      { code: "c", subsystem: "ingest", retryable: "yes" },
      { code: "c", subsystem: "ingest", retryable: false, detail: 3 },
    ];
    for (const value of bad) {
      expect(isServiceError(value)).toBe(false);
    }
  });
});

describe("wrapError", () => {
  it("wraps a network-ish throw into metrics_upstream, retryable", () => {
    const thrown = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
      code: "ECONNREFUSED",
    });

    const err = wrapError(thrown, {
      subsystem: "metrics",
      code: METRICS_UPSTREAM,
      retryable: true,
    });

    expect(isServiceError(err)).toBe(true);
    expect(err.code).toBe("metrics_upstream");
    expect(err.subsystem).toBe("metrics");
    expect(err.retryable).toBe(true);
    expect(err.detail).toContain("ECONNREFUSED");
  });

  it("chains the original error on native .cause, keeping structured fields inspectable", () => {
    const upstream = Object.assign(new Error("upstream HTTP 503"), { status: 503 });

    const err = wrapError(upstream, {
      subsystem: "metrics",
      code: METRICS_UPSTREAM,
      retryable: true,
    });

    expect(err.cause).toBe(upstream); // the structured original, not a flattened string
    expect((err.cause as { status?: number }).status).toBe(503);
    expect(err.detail).toBe("upstream HTTP 503"); // serialized summary kept separately
    expect(err.code).toBe("metrics_upstream");
    expect(err.subsystem).toBe("metrics");
    expect(err.retryable).toBe(true);
  });

  it("keeps an existing ServiceError's own classification", () => {
    const original = wellKnown(DIGEST_LLM_DOWN, "ollama refused");

    const wrapped = wrapError(original, {
      subsystem: "http",
      code: HTTP_BAD_REQUEST,
      retryable: false,
    });

    expect(wrapped).toBe(original);
    expect(wrapped.code).toBe("digest_llm_down");
    expect(wrapped.subsystem).toBe("digest");
    expect(wrapped.retryable).toBe(true);
  });

  it("normalizes a foreign shape-matching object into a real ServiceError", () => {
    const foreign = { code: "x", subsystem: "scheduler", retryable: false, detail: "cron" };

    const wrapped = wrapError(foreign, {
      subsystem: "http",
      code: HTTP_BAD_REQUEST,
      retryable: false,
    });

    expect(wrapped).toBeInstanceOf(ServiceError);
    expect(wrapped.code).toBe("x");
    expect(wrapped.subsystem).toBe("scheduler");
    expect(wrapped.retryable).toBe(false);
    expect(wrapped.detail).toBe("cron");
    expect(wrapped.cause).toBe(foreign); // observed object preserved on native .cause
  });

  it("stringifies non-Error throws into detail and preserves them on .cause", () => {
    const fromString = wrapError("kaboom", {
      subsystem: "http",
      code: HTTP_BAD_REQUEST,
      retryable: false,
    });
    expect(fromString.detail).toBe("kaboom");
    expect(fromString.cause).toBe("kaboom");

    const weird = { weird: true };
    const fromObject = wrapError(weird, {
      subsystem: "metrics",
      code: METRICS_UPSTREAM,
      retryable: true,
    });
    expect(fromObject.detail).toBe("[object Object]");
    expect(fromObject.cause).toBe(weird);
  });
});

describe("causeMessage", () => {
  it("extracts Error.message, passes strings through, stringifies the rest", () => {
    expect(causeMessage(new Error("disk full"))).toBe("disk full");
    expect(causeMessage("raw")).toBe("raw");
    expect(causeMessage(404)).toBe("404");
    expect(causeMessage(undefined)).toBe("undefined");
  });
});

describe("http_bad_request", () => {
  it("is non-retryable and belongs to the http subsystem", () => {
    const err = wellKnown(HTTP_BAD_REQUEST, "missing field platform");

    expect(err.code).toBe("http_bad_request");
    expect(err.subsystem).toBe("http");
    expect(err.retryable).toBe(false);
  });
});
