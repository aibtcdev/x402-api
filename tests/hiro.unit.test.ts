#!/usr/bin/env bun
/**
 * Unit tests for Hiro client resilience and caching (#124)
 */

import { describe, expect, test, afterEach } from "bun:test";
import {
  HiroApiError,
  HiroClient,
  clearHiroCacheForTesting,
  fetchHiroJson,
  parseRetryAfterMs,
} from "../src/services/hiro";
import type { Logger } from "../src/types";
import {
  isRetryableError,
  isUpstreamHiroRateLimitResponse,
} from "./_shared_utils";

const testLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => testLog,
};

afterEach(() => {
  clearHiroCacheForTesting();
});

describe("parseRetryAfterMs", () => {
  test("parses seconds and caps at 10s", () => {
    expect(parseRetryAfterMs("5")).toBe(5000);
    expect(parseRetryAfterMs("60")).toBe(10_000);
  });

  test("parses HTTP-date Retry-After", () => {
    const now = Date.parse("Wed, 21 Oct 2026 12:00:00 GMT");
    const header = "Wed, 21 Oct 2026 12:00:02 GMT";
    expect(parseRetryAfterMs(header, now)).toBe(2000);
  });
});

describe("fetchHiroJson 429 handling", () => {
  test("retries on 429 with exponential backoff then succeeds", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const fetchFn = async () => {
      calls++;
      if (calls < 3) {
        return new Response("too many", { status: 429 });
      }
      return Response.json({ height: 1 });
    };

    const result = await fetchHiroJson<{ height: number }>(
      "https://api.hiro.so/test",
      {},
      testLog,
      {
        fetchFn,
        sleepFn: async (ms) => {
          sleeps.push(ms);
        },
        retry429DelaysMs: [10, 20, 40],
        max429Retries: 3,
      }
    );

    expect(result.data.height).toBe(1);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([10, 20]);
  });

  test("honors Retry-After header over default backoff", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const fetchFn = async () => {
      calls++;
      if (calls === 1) {
        return new Response("limited", {
          status: 429,
          headers: { "Retry-After": "3" },
        });
      }
      return Response.json({ ok: true });
    };

    await fetchHiroJson("https://api.hiro.so/test", {}, testLog, {
      fetchFn,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      retry429DelaysMs: [10],
      max429Retries: 1,
    });

    expect(sleeps[0]).toBe(3000);
  });

  test("throws HiroApiError 429 after exhausting retries", async () => {
    const fetchFn = async () => new Response("nope", { status: 429 });

    await expect(
      fetchHiroJson("https://api.hiro.so/test", {}, testLog, {
        fetchFn,
        sleepFn: async () => {},
        retry429DelaysMs: [1],
        max429Retries: 2,
      })
    ).rejects.toMatchObject({ status: 429, name: "HiroApiError" });
  });

  test("pauses when rate-limit-remaining is low on success", async () => {
    const sleeps: number[] = [];
    const fetchFn = async () =>
      new Response(JSON.stringify({ ok: 1 }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "x-ratelimit-remaining-stacks-second": "1",
        },
      });

    await fetchHiroJson("https://api.hiro.so/test", {}, testLog, {
      fetchFn,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(sleeps).toEqual([250]);
  });
});

describe("HiroClient caching", () => {
  test("getCurrentBlock uses cache for 60s TTL", async () => {
    let fetches = 0;
    const fetchFn = async () => {
      fetches++;
      return Response.json({
        results: [{ height: 100, hash: "0xabc", burn_block_time: 1, burn_block_time_iso: "" }],
      });
    };

    const client = new HiroClient(testLog, "mainnet", undefined, {
      fetchFn,
      sleepFn: async () => {},
    });

    const a = await client.getCurrentBlock();
    const b = await client.getCurrentBlock();
    expect(a.height).toBe(100);
    expect(b.height).toBe(100);
    expect(fetches).toBe(1);
  });

  test("getBnsNames caches per address for 1h TTL", async () => {
    let fetches = 0;
    const fetchFn = async (url: string | URL | Request) => {
      fetches++;
      const path = String(url);
      if (path.includes("/v1/addresses/stacks/")) {
        return Response.json({ names: ["alice.btc"] });
      }
      return new Response("not found", { status: 404 });
    };

    const client = new HiroClient(testLog, "mainnet", undefined, {
      fetchFn,
      sleepFn: async () => {},
    });

    const addr = "SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9";
    await client.getBnsNames(addr);
    await client.getBnsNames(addr);
    expect(fetches).toBe(1);
  });

  test("getAccountBalance and getAccountInfo cache separately ~20s", async () => {
    const paths: string[] = [];
    const fetchFn = async (url: string | URL | Request) => {
      paths.push(String(url));
      if (String(url).includes("/balances")) {
        return Response.json({
          stx: { balance: "1", locked: "0", burnchain_unlock_height: 0 },
          fungible_tokens: {},
          non_fungible_tokens: {},
        });
      }
      if (String(url).includes("/v2/accounts/")) {
        return Response.json({
          balance: "1",
          locked: "0",
          unlock_height: 0,
          nonce: 2,
          balance_proof: "",
          nonce_proof: "",
        });
      }
      return new Response("err", { status: 500 });
    };

    const client = new HiroClient(testLog, "mainnet", undefined, {
      fetchFn,
      sleepFn: async () => {},
    });

    const addr = "SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9";
    await client.getAccountBalance(addr);
    await client.getAccountInfo(addr);
    await client.getAccountBalance(addr);
    await client.getAccountInfo(addr);

    expect(paths.filter((p) => p.includes("/balances")).length).toBe(1);
    expect(paths.filter((p) => p.includes("/v2/accounts/")).length).toBe(1);
  });

  test("clearHiroCacheForTesting resets cached entries", async () => {
    let fetches = 0;
    const fetchFn = async () => {
      fetches++;
      return Response.json({
        results: [{ height: 1, hash: "h", burn_block_time: 0, burn_block_time_iso: "" }],
      });
    };

    const client = new HiroClient(testLog, "mainnet", undefined, {
      fetchFn,
      sleepFn: async () => {},
    });

    await client.getCurrentBlock();
    clearHiroCacheForTesting();
    await client.getCurrentBlock();
    expect(fetches).toBe(2);
  });
});

describe("test harness Hiro 429-origin detection", () => {
  test("isUpstreamHiroRateLimitResponse matches wrapped 429 errors", () => {
    expect(
      isUpstreamHiroRateLimitResponse(500, "API error: Failed to fetch balance: 429")
    ).toBe(true);
    expect(isUpstreamHiroRateLimitResponse(502, undefined, "rate limit exceeded")).toBe(true);
    expect(isUpstreamHiroRateLimitResponse(503, "service unavailable")).toBe(false);
  });

  test("isRetryableError skips 500 when Hiro 429 is in the message", () => {
    expect(
      isRetryableError(500, undefined, "API error: Failed to fetch block: 429")
    ).toBe(false);
    expect(isRetryableError(500, undefined, "internal facilitator error")).toBe(true);
  });
});

describe("HiroApiError", () => {
  test("exposes status for instanceof checks", () => {
    const err = new HiroApiError("limited", 429);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(429);
  });
});
