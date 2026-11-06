#!/usr/bin/env bun
/**
 * /stacks/profile: a Hiro 429 must reach the caller as 503 + Retry-After
 * (retryable upstream rate limit), not as a 500 server fault (#124).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { Profile } from "../src/endpoints/stacks/profile";
import { parseRetryAfterSeconds } from "../src/services/hiro";
import type { Env, AppVariables, Logger } from "../src/types";

const ADDRESS = "SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9";

function makeLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: function () {
      return this;
    },
  };
}

function buildApp() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("/stacks/profile/:address", async (c, next) => {
    c.set("requestId", "test-req-id");
    c.set("logger", makeLogger());
    return next();
  });
  const handler = new Profile();
  app.get("/stacks/profile/:address", (c) => handler.handle(c));
  return app;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubHiro(status: number, headers: Record<string, string> = {}) {
  globalThis.fetch = (async () =>
    new Response("rate limited", { status, headers })) as typeof fetch;
}

describe("/stacks/profile Hiro 429", () => {
  test("returns 503 with Hiro's Retry-After when Hiro sends one", async () => {
    stubHiro(429, { "Retry-After": "7" });
    const res = await buildApp().request(`/stacks/profile/${ADDRESS}`, {}, { X402_NETWORK: "mainnet" } as Env);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("7");
    const body = (await res.json()) as { ok: boolean; retryable: boolean; retryAfter: number };
    expect(body.ok).toBe(false);
    expect(body.retryable).toBe(true);
    expect(body.retryAfter).toBe(7);
  });

  test("defaults Retry-After to one 60 s window when Hiro sends none", async () => {
    stubHiro(429);
    const res = await buildApp().request(`/stacks/profile/${ADDRESS}`, {}, { X402_NETWORK: "mainnet" } as Env);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  test("other upstream failures keep their existing mapping (5xx -> 502)", async () => {
    stubHiro(503);
    const res = await buildApp().request(`/stacks/profile/${ADDRESS}`, {}, { X402_NETWORK: "mainnet" } as Env);
    expect(res.status).toBe(502);
    expect(res.headers.get("Retry-After")).toBeNull();
  });
});

describe("parseRetryAfterSeconds", () => {
  const r = (v?: string) => new Response(null, v ? { headers: { "Retry-After": v } } : {});
  test("reads delta-seconds", () => expect(parseRetryAfterSeconds(r("12"))).toBe(12));
  test("ignores absent, zero, negative and HTTP-date forms", () => {
    expect(parseRetryAfterSeconds(r())).toBeUndefined();
    expect(parseRetryAfterSeconds(r("0"))).toBeUndefined();
    expect(parseRetryAfterSeconds(r("-5"))).toBeUndefined();
    expect(parseRetryAfterSeconds(r("Wed, 21 Oct 2015 07:28:00 GMT"))).toBeUndefined();
  });
});
