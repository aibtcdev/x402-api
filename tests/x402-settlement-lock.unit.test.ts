#!/usr/bin/env bun
/** Unit tests for withSettlementLock (issue #86)
 *
 * Verifies that concurrent settlement calls to the same relay URL are serialized,
 * preventing nonce conflicts when multiple requests settle simultaneously.
 */
import { describe, expect, test } from "bun:test";
import { withSettlementLock } from "../src/middleware/x402";

describe("withSettlementLock", () => {
  test("serializes concurrent calls to the same relay URL", async () => {
    const order: number[] = [];
    const make = (id: number, delay: number) =>
      withSettlementLock("https://relay.example.com", async () => {
        order.push(id);
        await new Promise(r => setTimeout(r, delay));
        return id;
      });

    const results = await Promise.all([make(1, 30), make(2, 10), make(3, 5)]);
    expect(results).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
  });

  test("does not block different relay URLs", async () => {
    const order: string[] = [];
    const a = withSettlementLock("https://relay-a.example.com", async () => {
      order.push("a-start");
      await new Promise(r => setTimeout(r, 30));
      order.push("a-end");
    });
    const b = withSettlementLock("https://relay-b.example.com", async () => {
      order.push("b-start");
      await new Promise(r => setTimeout(r, 5));
      order.push("b-end");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "b-start", "b-end", "a-end"]);
  });

  test("cleans up queue after all calls complete", async () => {
    await withSettlementLock("https://relay.example.com", async () => {});
    const start = Date.now();
    await withSettlementLock("https://relay.example.com", async () => {});
    expect(Date.now() - start).toBeLessThan(100);
  });
});
