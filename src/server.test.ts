import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "./server.js";

let server: Server;
let base: string;

beforeAll(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("health", () => {
  it("returns ok with subsystem stubs", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe("pr-manager");
    expect(body.subsystems.ingest).toEqual({ last_success: null, last_error: null });
  });
});

describe("stubs", () => {
  it("state summary answers 501 not implemented", async () => {
    const res = await fetch(`${base}/state/summary`);
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: "not implemented" });
  });

  it("audit run answers 501 not implemented", async () => {
    const res = await fetch(`${base}/audit/run`, { method: "POST" });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: "not implemented" });
  });
});

describe("error handling", () => {
  it("unknown route answers JSON 404", async () => {
    const res = await fetch(`${base}/no-such-route`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: "not found" });
  });
});
