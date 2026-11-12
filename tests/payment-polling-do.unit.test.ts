/**
 * Unit tests for PaymentPollingDO pure functions and track→poll→terminal flow.
 *
 * Tests use bun:test (same runner as other unit tests in this repo).
 * Run with: bun test tests/payment-polling-do.unit.test.ts
 *
 * Covers:
 * 1. computeDerivedHints — all terminal reason categories
 * 2. Happy-path track → poll → confirmed flow (via DO stub)
 * 3. derivedHints returns null for in-flight payments
 */

import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
// Import pure utility from payment-hints (no cloudflare:workers dependency)
import { computeDerivedHints } from "../src/utils/payment-hints";
import type { DerivedHints } from "../src/utils/payment-hints";
// DO types only — not the class itself (would require cloudflare:workers runtime)
import type {
  PaymentTrackInput,
  PaymentStatusSnapshot,
} from "../src/durable-objects/PaymentPollingDO";

// =============================================================================
// computeDerivedHints — pure function tests (no DO needed)
// =============================================================================

describe("computeDerivedHints", () => {
  test("returns null for non-terminal status 'queued'", () => {
    expect(computeDerivedHints("queued")).toBeNull();
  });

  test("returns null for non-terminal status 'broadcasting'", () => {
    expect(computeDerivedHints("broadcasting")).toBeNull();
  });

  test("returns null for non-terminal status 'mempool'", () => {
    expect(computeDerivedHints("mempool")).toBeNull();
  });

  test("confirmed → wait_for_confirmation, not retryable", () => {
    const hints = computeDerivedHints("confirmed");
    expect(hints).not.toBeNull();
    expect(hints!.retryable).toBe(false);
    expect(hints!.nextSteps).toBe("wait_for_confirmation");
    expect(hints!.retryAfter).toBeUndefined();
  });

  // sender category → rebuild_and_resign
  test.each([
    "sender_nonce_stale",
    "sender_nonce_gap",
    "sender_nonce_duplicate",
    "origin_chaining_limit",
    "sender_hand_expired",
  ] as const)("sender reason '%s' → rebuild_and_resign, retryable", (reason) => {
    const hints = computeDerivedHints("failed", reason);
    expect(hints).not.toBeNull();
    expect(hints!.retryable).toBe(true);
    expect(hints!.nextSteps).toBe("rebuild_and_resign");
    expect(hints!.retryAfter).toBeUndefined();
  });

  // relay category → retry_later with retryAfter
  test.each([
    "queue_unavailable",
    "sponsor_failure",
    "internal_error",
    "sponsor_exhausted",
    "sponsor_nonce_conflict",
  ] as const)("relay reason '%s' → retry_later, retryable, retryAfter=30", (reason) => {
    const hints = computeDerivedHints("failed", reason);
    expect(hints).not.toBeNull();
    expect(hints!.retryable).toBe(true);
    expect(hints!.nextSteps).toBe("retry_later");
    expect(hints!.retryAfter).toBe(30);
  });

  // settlement category → retry_later with retryAfter
  test.each([
    "broadcast_failure",
    "chain_abort",
    "broadcast_rate_limited",
  ] as const)("settlement reason '%s' → retry_later, retryable, retryAfter=30", (reason) => {
    const hints = computeDerivedHints("failed", reason);
    expect(hints).not.toBeNull();
    expect(hints!.retryable).toBe(true);
    expect(hints!.nextSteps).toBe("retry_later");
    expect(hints!.retryAfter).toBe(30);
  });

  // replacement category → start_new_payment, not retryable
  test.each([
    "nonce_replacement",
    "superseded",
  ] as const)("replacement reason '%s' → start_new_payment, not retryable", (reason) => {
    const hints = computeDerivedHints("replaced", reason);
    expect(hints).not.toBeNull();
    expect(hints!.retryable).toBe(false);
    expect(hints!.nextSteps).toBe("start_new_payment");
    expect(hints!.retryAfter).toBeUndefined();
  });

  // identity category → start_new_payment, not retryable
  test.each([
    "expired",
    "unknown_payment_identity",
  ] as const)("identity reason '%s' → start_new_payment, not retryable", (reason) => {
    const hints = computeDerivedHints("not_found", reason);
    expect(hints).not.toBeNull();
    expect(hints!.retryable).toBe(false);
    expect(hints!.nextSteps).toBe("start_new_payment");
    expect(hints!.retryAfter).toBeUndefined();
  });

  // validation category → fix_and_resend, not retryable
  test.each([
    "invalid_transaction",
    "not_sponsored",
  ] as const)("validation reason '%s' → fix_and_resend, not retryable", (reason) => {
    const hints = computeDerivedHints("failed", reason);
    expect(hints).not.toBeNull();
    expect(hints!.retryable).toBe(false);
    expect(hints!.nextSteps).toBe("fix_and_resend");
    expect(hints!.retryAfter).toBeUndefined();
  });

  test("terminal status without terminalReason → start_new_payment, not retryable", () => {
    const hints = computeDerivedHints("failed");
    expect(hints).not.toBeNull();
    expect(hints!.retryable).toBe(false);
    expect(hints!.nextSteps).toBe("start_new_payment");
  });

  test("unknown terminal reason → start_new_payment, not retryable (safe fallback)", () => {
    const hints = computeDerivedHints("failed", "completely_unknown_reason_xyz");
    expect(hints).not.toBeNull();
    expect(hints!.retryable).toBe(false);
    expect(hints!.nextSteps).toBe("start_new_payment");
  });
});

// =============================================================================
// DO stub — minimal SQLite-in-memory simulation via bun
// =============================================================================

/**
 * Minimal DO stub for track → poll → terminal flow tests.
 *
 * We cannot instantiate PaymentPollingDO directly (requires cloudflare:workers
 * runtime), so we test the logic paths using a stub that mirrors the DO's
 * internal _fetchStatus contract. The computeDerivedHints function (already
 * tested above) is what derivedHints() delegates to.
 *
 * This test validates:
 * 1. track() accepts a PaymentTrackInput and records initial state
 * 2. poll() calls _fetchStatus and transitions to terminal when relay says so
 * 3. status() returns the cached snapshot
 * 4. derivedHints() delegates to computeDerivedHints correctly
 */

/**
 * PaymentPollingDO internal state stub — mirrors the DB row shape
 * so we can simulate the track → poll → terminal lifecycle.
 */
interface StubRow {
  paymentId: string;
  checkStatusUrl: string;
  payerAddress: string;
  route: string;
  tokenType: string;
  status: string;
  terminalReason?: string;
  txid?: string;
  confirmedAt?: string;
  polledAt: string;
  pollCount: number;
  isTerminal: boolean;
}

/**
 * Minimal stub that re-implements the DO lifecycle without Cloudflare APIs.
 * Delegates hint computation to computeDerivedHints (already tested above).
 */
class PaymentPollingDOStub {
  private state: StubRow | null = null;
  private fetchStatus: (paymentId: string, checkStatusUrl: string) => Promise<{
    status: string;
    terminalReason?: string;
    txid?: string;
    confirmedAt?: string;
  }>;

  constructor(
    fetchStatus: typeof this.fetchStatus
  ) {
    this.fetchStatus = fetchStatus;
  }

  async track(input: PaymentTrackInput): Promise<void> {
    if (this.state) return; // idempotent
    const now = new Date().toISOString();
    this.state = {
      paymentId: input.paymentId,
      checkStatusUrl: input.checkStatusUrl,
      payerAddress: input.payerAddress,
      route: input.route,
      tokenType: input.tokenType,
      status: "queued",
      polledAt: now,
      pollCount: 0,
      isTerminal: false,
    };
  }

  async poll(): Promise<PaymentStatusSnapshot | null> {
    if (!this.state || this.state.isTerminal) return null;

    const { paymentId, checkStatusUrl } = this.state;
    const pollCount = this.state.pollCount + 1;
    const now = new Date().toISOString();

    const result = await this.fetchStatus(paymentId, checkStatusUrl);
    const isTerminal = ["confirmed", "failed", "replaced", "not_found"].includes(result.status);

    this.state = {
      ...this.state,
      status: result.status,
      terminalReason: result.terminalReason,
      txid: result.txid,
      confirmedAt: result.confirmedAt,
      polledAt: now,
      pollCount,
      isTerminal,
    };

    return {
      paymentId,
      status: result.status,
      terminalReason: result.terminalReason,
      txid: result.txid,
      confirmedAt: result.confirmedAt,
      checkStatusUrl,
      polledAt: now,
      pollCount,
    };
  }

  async status(): Promise<PaymentStatusSnapshot | null> {
    if (!this.state) return null;
    return {
      paymentId: this.state.paymentId,
      status: this.state.status,
      terminalReason: this.state.terminalReason,
      txid: this.state.txid,
      confirmedAt: this.state.confirmedAt,
      checkStatusUrl: this.state.checkStatusUrl,
      polledAt: this.state.polledAt,
      pollCount: this.state.pollCount,
    };
  }

  async derivedHints(): Promise<DerivedHints | null> {
    const snap = await this.status();
    if (!snap) return null;
    return computeDerivedHints(snap.status, snap.terminalReason);
  }
}

// =============================================================================
// DO lifecycle tests
// =============================================================================

describe("PaymentPollingDO lifecycle (stub)", () => {
  const testInput: PaymentTrackInput = {
    paymentId: "pay_test123",
    checkStatusUrl: "https://relay.example.com/payment-status/pay_test123",
    payerAddress: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
    route: "/hashing/sha256",
    tokenType: "STX",
  };

  test("track → status returns queued initial state", async () => {
    const stub = new PaymentPollingDOStub(async () => ({ status: "queued" }));
    await stub.track(testInput);
    const snap = await stub.status();
    expect(snap).not.toBeNull();
    expect(snap!.paymentId).toBe("pay_test123");
    expect(snap!.status).toBe("queued");
    expect(snap!.pollCount).toBe(0);
    expect(snap!.checkStatusUrl).toBe(testInput.checkStatusUrl);
  });

  test("track → poll → confirmed: snapshot is terminal", async () => {
    const now = new Date().toISOString();
    const stub = new PaymentPollingDOStub(async () => ({
      status: "confirmed",
      txid: "0xabc123",
      confirmedAt: now,
    }));
    await stub.track(testInput);
    const snap = await stub.poll();
    expect(snap).not.toBeNull();
    expect(snap!.status).toBe("confirmed");
    expect(snap!.txid).toBe("0xabc123");
    expect(snap!.pollCount).toBe(1);
  });

  test("poll after terminal returns null (no re-poll)", async () => {
    const stub = new PaymentPollingDOStub(async () => ({ status: "confirmed" }));
    await stub.track(testInput);
    await stub.poll(); // first poll → confirmed
    const snap = await stub.poll(); // second poll → null (already terminal)
    expect(snap).toBeNull();
  });

  test("track → poll → failed with terminalReason", async () => {
    const stub = new PaymentPollingDOStub(async () => ({
      status: "failed",
      terminalReason: "sender_nonce_stale",
    }));
    await stub.track(testInput);
    const snap = await stub.poll();
    expect(snap!.status).toBe("failed");
    expect(snap!.terminalReason).toBe("sender_nonce_stale");
  });

  test("track → poll (in-flight) → poll (confirmed): increments pollCount", async () => {
    let callCount = 0;
    const stub = new PaymentPollingDOStub(async () => {
      callCount += 1;
      return callCount < 2 ? { status: "mempool" } : { status: "confirmed", txid: "0xfinal" };
    });
    await stub.track(testInput);
    const snap1 = await stub.poll();
    expect(snap1!.status).toBe("mempool");
    expect(snap1!.pollCount).toBe(1);
    const snap2 = await stub.poll();
    expect(snap2!.status).toBe("confirmed");
    expect(snap2!.pollCount).toBe(2);
  });

  test("track is idempotent — double track does not reset state", async () => {
    let callCount = 0;
    const stub = new PaymentPollingDOStub(async () => ({ status: "confirmed" }));
    await stub.track(testInput);
    await stub.poll(); // → confirmed, pollCount=1
    await stub.track(testInput); // should be no-op
    const snap = await stub.status();
    expect(snap!.status).toBe("confirmed");
    expect(snap!.pollCount).toBe(1);
  });

  test("status() returns null before track()", async () => {
    const stub = new PaymentPollingDOStub(async () => ({ status: "queued" }));
    const snap = await stub.status();
    expect(snap).toBeNull();
  });

  test("derivedHints returns null for in-flight payment", async () => {
    const stub = new PaymentPollingDOStub(async () => ({ status: "mempool" }));
    await stub.track(testInput);
    await stub.poll();
    const hints = await stub.derivedHints();
    expect(hints).toBeNull();
  });

  test("derivedHints returns rebuild_and_resign after sender_nonce_stale failure", async () => {
    const stub = new PaymentPollingDOStub(async () => ({
      status: "failed",
      terminalReason: "sender_nonce_stale",
    }));
    await stub.track(testInput);
    await stub.poll();
    const hints = await stub.derivedHints();
    expect(hints).not.toBeNull();
    expect(hints!.retryable).toBe(true);
    expect(hints!.nextSteps).toBe("rebuild_and_resign");
  });

  test("derivedHints returns retry_later after queue_unavailable failure", async () => {
    const stub = new PaymentPollingDOStub(async () => ({
      status: "failed",
      terminalReason: "queue_unavailable",
    }));
    await stub.track(testInput);
    await stub.poll();
    const hints = await stub.derivedHints();
    expect(hints).not.toBeNull();
    expect(hints!.retryable).toBe(true);
    expect(hints!.nextSteps).toBe("retry_later");
    expect(hints!.retryAfter).toBe(30);
  });

  test("derivedHints returns wait_for_confirmation after confirmed", async () => {
    const stub = new PaymentPollingDOStub(async () => ({
      status: "confirmed",
      txid: "0xfinal",
    }));
    await stub.track(testInput);
    await stub.poll();
    const hints = await stub.derivedHints();
    expect(hints).not.toBeNull();
    expect(hints!.retryable).toBe(false);
    expect(hints!.nextSteps).toBe("wait_for_confirmation");
  });
});


// =============================================================================
// Real PaymentPollingDO tx_guard, claimTx, clearBoundTx & alarm() unit tests
// =============================================================================

mock.module("cloudflare:workers", () => ({
  DurableObject: class DurableObject<E = unknown> {
    ctx: DurableObjectState;
    env: E;
    constructor(ctx: DurableObjectState, env: E) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const {
  PaymentPollingDO,
  TX_BOUND_TTL_MS,
  TX_CONSUMED_TTL_MS,
} = await import("../src/durable-objects/PaymentPollingDO");

function createInMemoryDO() {
  const db = new Database(":memory:");
  let scheduledAlarm: number | null = null;
  let pendingConcurrency: Promise<unknown> | null = null;

  const sql = {
    exec(query: string, ...params: unknown[]) {
      const trimmed = query.trim();
      const withoutTrailingSemi = trimmed.replace(/;+s*$/, "");
      // Multi-statement DDL (e.g. SCHEMA_SQL) has embedded semicolons
      if (withoutTrailingSemi.includes(";")) {
        db.exec(trimmed);
        return { toArray: () => [], [Symbol.iterator]: () => [][Symbol.iterator]() };
      }
      const stmt = db.query(trimmed);
      const upper = trimmed.toUpperCase();
      if (upper.startsWith("SELECT") || upper.startsWith("PRAGMA")) {
        const rows = stmt.all(...(params as never[])) as Record<string, unknown>[];
        return {
          toArray: () => rows,
          [Symbol.iterator]: () => rows[Symbol.iterator](),
        };
      }
      stmt.run(...(params as never[]));
      return { toArray: () => [], [Symbol.iterator]: () => [][Symbol.iterator]() };
    },
  };

  const ctx = {
    storage: {
      sql,
      async getAlarm() {
        return scheduledAlarm;
      },
      async setAlarm(scheduledTime: number | Date) {
        scheduledAlarm =
          typeof scheduledTime === "number" ? scheduledTime : scheduledTime.getTime();
      },
      async deleteAlarm() {
        scheduledAlarm = null;
      },
    },
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      const p = fn();
      pendingConcurrency = p;
      return p;
    },
  } as unknown as DurableObjectState;

  const env = {
    X402_FACILITATOR_URL: "https://relay.example",
  } as never;

  const instance = new PaymentPollingDO(ctx, env);

  return {
    instance,
    db,
    ready: async () => {
      await pendingConcurrency;
    },
    getAlarm: () => scheduledAlarm,
  };
}

describe("PaymentPollingDO real tx_guard & alarm() lifecycle", () => {
  test("claimTx serializes concurrent claims, honors TTL expiry, and guards releaseTxClaim", async () => {
    const { instance, db, ready, getAlarm } = createInMemoryDO();
    await ready();

    const first = await instance.claimTx({
      txHash: "tx_abc",
      claimId: "claim_1",
      expectedRecipient: "ST_SELLER",
      minAmount: "1000",
      asset: "STX",
      network: "stacks:2147483648",
      verifiedPayer: "ST_BUYER",
      requestBindingHash: "hash_req_1",
    });
    expect(first.status).toBe("claimed");
    expect(getAlarm()).not.toBeNull();

    // Concurrent second claim with a different claimId gets in_progress and does NOT overwrite row
    const second = await instance.claimTx({
      txHash: "tx_abc",
      claimId: "claim_2",
      expectedRecipient: "ST_SELLER",
      minAmount: "9999",
      asset: "STX",
      network: "stacks:2147483648",
      verifiedPayer: "ST_BUYER",
      requestBindingHash: "hash_req_different",
    });
    expect(second.status).toBe("in_progress");
    if (second.status === "in_progress") {
      expect(second.record.minAmount).toBe("1000");
      expect(second.record.requestBindingHash).toBe("hash_req_1");
    }

    // Wrong claimId cannot release claim_1
    await instance.releaseTxClaim("claim_2");
    expect((await instance.getTxGuard())?.claimId).toBe("claim_1");

    // Matching claimId releases row cleanly
    await instance.releaseTxClaim("claim_1");
    expect(await instance.getTxGuard()).toBeNull();
    expect(getAlarm()).toBeNull();

    // Stale claim whose TTL expired can be re-claimed by another isolate
    await instance.claimTx({
      txHash: "tx_abc",
      claimId: "claim_stale",
      expectedRecipient: "ST_SELLER",
      minAmount: "1000",
      asset: "STX",
      network: "stacks:2147483648",
      requestBindingHash: "hash_req_1",
    });
    db.query("UPDATE tx_guard SET claim_expires_at = ? WHERE id = 1").run(Date.now() - 1000);

    const reclaimed = await instance.claimTx({
      txHash: "tx_abc",
      claimId: "claim_fresh",
      expectedRecipient: "ST_SELLER",
      minAmount: "1000",
      asset: "STX",
      network: "stacks:2147483648",
      requestBindingHash: "hash_req_1",
    });
    expect(reclaimed.status).toBe("claimed");
    if (reclaimed.status === "claimed") {
      expect(reclaimed.record.claimId).toBe("claim_fresh");
    }

    // bindTxPayment with missing or mismatched claimId must NOT overwrite active claim_fresh
    const hijackedNoClaim = await instance.bindTxPayment({
      txHash: "tx_abc",
      relayPaymentId: "pay_hijack_none",
      expectedRecipient: "ST_SELLER",
      minAmount: "1000",
      asset: "STX",
      network: "stacks:2147483648",
      requestBindingHash: "hash_req_1",
    });
    expect(hijackedNoClaim.relayPaymentId).toBeUndefined();
    expect(hijackedNoClaim.claimId).toBe("claim_fresh");

    const hijackedWrongClaim = await instance.bindTxPayment({
      txHash: "tx_abc",
      relayPaymentId: "pay_hijack_wrong",
      expectedRecipient: "ST_SELLER",
      minAmount: "1000",
      asset: "STX",
      network: "stacks:2147483648",
      requestBindingHash: "hash_req_1",
      claimId: "claim_stale",
    });
    expect(hijackedWrongClaim.relayPaymentId).toBeUndefined();
    expect(hijackedWrongClaim.claimId).toBe("claim_fresh");

    // Matching claimId binds cleanly
    const boundValid = await instance.bindTxPayment({
      txHash: "tx_abc",
      relayPaymentId: "pay_fresh_bound",
      expectedRecipient: "ST_SELLER",
      minAmount: "1000",
      asset: "STX",
      network: "stacks:2147483648",
      requestBindingHash: "hash_req_1",
      claimId: "claim_fresh",
    });
    expect(boundValid.relayPaymentId).toBe("pay_fresh_bound");
    expect(boundValid.claimId).toBeUndefined();
  });

  test("bindTxPayment uses first-writer-wins on active unconsumed bindings and preserves consumed=1", async () => {
    const { instance, ready } = createInMemoryDO();
    await ready();

    const first = await instance.bindTxPayment({
      txHash: "tx_bind_1",
      relayPaymentId: "pay_first",
      expectedRecipient: "ST_SELLER",
      minAmount: "1000",
      asset: "STX",
      network: "stacks:2147483648",
      verifiedPayer: "ST_BUYER",
      requestBindingHash: "hash_1",
    });
    expect(first.relayPaymentId).toBe("pay_first");
    expect(first.minAmount).toBe("1000");

    // Second bind attempt with lower amount / different binding hash must NOT overwrite first binding
    const second = await instance.bindTxPayment({
      txHash: "tx_bind_1",
      relayPaymentId: "pay_second",
      expectedRecipient: "ST_SELLER",
      minAmount: "1",
      asset: "STX",
      network: "stacks:2147483648",
      verifiedPayer: "ST_BUYER",
      requestBindingHash: "hash_2",
    });
    expect(second.relayPaymentId).toBe("pay_first");
    expect(second.minAmount).toBe("1000");
    expect(second.requestBindingHash).toBe("hash_1");

    // Mark consumed, then verify bindTxPayment neither clears consumed nor replaces relayPaymentId
    const consumedRes = await instance.markTxConsumed({
      txHash: "tx_bind_1",
      relayPaymentId: "pay_first",
      txid: "0xconfirmed1",
    });
    expect(consumedRes.alreadyConsumed).toBe(false);
    expect(consumedRes.record.consumed).toBe(true);

    const postConsumedBind = await instance.bindTxPayment({
      txHash: "tx_bind_1",
      relayPaymentId: "pay_third",
      expectedRecipient: "ST_SELLER",
      minAmount: "500",
      asset: "STX",
      network: "stacks:2147483648",
      requestBindingHash: "hash_3",
    });
    expect(postConsumedBind.consumed).toBe(true);
    expect(postConsumedBind.relayPaymentId).toBe("pay_first");
  });

  test("clearBoundTx requires matching expectedRelayPaymentId and is a strict no-op when consumed=1", async () => {
    const { instance, ready, getAlarm } = createInMemoryDO();
    await ready();

    await instance.bindTxPayment({
      txHash: "tx_clear_1",
      relayPaymentId: "pay_real",
      expectedRecipient: "ST_SELLER",
      minAmount: "1000",
      asset: "STX",
      network: "stacks:2147483648",
      requestBindingHash: "hash_clear",
    });

    // Empty or mismatched relayPaymentId must NOT delete bound record
    await instance.clearBoundTx("");
    await instance.clearBoundTx("pay_wrong");
    expect((await instance.getTxGuard())?.relayPaymentId).toBe("pay_real");

    // Matching relayPaymentId deletes unconsumed record and clears cleanup alarm
    await instance.clearBoundTx("pay_real");
    expect(await instance.getTxGuard()).toBeNull();
    expect(getAlarm()).toBeNull();

    // Consumed row must NEVER be cleared even when expectedRelayPaymentId matches
    await instance.bindTxPayment({
      txHash: "tx_clear_1",
      relayPaymentId: "pay_consumed_keep",
      expectedRecipient: "ST_SELLER",
      minAmount: "1000",
      asset: "STX",
      network: "stacks:2147483648",
      requestBindingHash: "hash_clear",
    });
    await instance.markTxConsumed({
      txHash: "tx_clear_1",
      relayPaymentId: "pay_consumed_keep",
      txid: "0xkeep",
    });

    await instance.clearBoundTx("pay_consumed_keep");
    const afterClear = await instance.getTxGuard();
    expect(afterClear).not.toBeNull();
    expect(afterClear?.consumed).toBe(true);
    expect(afterClear?.relayPaymentId).toBe("pay_consumed_keep");
  });

  test("alarm() cleans expired tx_guard rows without disrupting active payment_state polling alarms", async () => {
    const { instance, db, ready, getAlarm } = createInMemoryDO();
    await ready();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ paymentId: "pay_active_poll", status: "queued" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    try {
      // 1. Non-expired tx_guard survives alarm() and keeps cleanup alarm scheduled
      const now = Date.now();
      await instance.bindTxPayment({
        txHash: "tx_alarm_1",
        relayPaymentId: "pay_alarm_1",
        expectedRecipient: "ST_SELLER",
        minAmount: "1000",
        asset: "STX",
        network: "stacks:2147483648",
        requestBindingHash: "hash_alarm",
        boundAt: now,
      });
      await instance.alarm();
      expect(await instance.getTxGuard()).not.toBeNull();
      expect(getAlarm()).toBe(now + TX_BOUND_TTL_MS);

      // 2. Expired tx_guard (without active payment_state) is deleted and alarm is cleared
      db.query("UPDATE tx_guard SET bound_at = ? WHERE id = 1").run(
        now - TX_BOUND_TTL_MS - 5000
      );
      await instance.alarm();
      expect(await instance.getTxGuard()).toBeNull();
      expect(getAlarm()).toBeNull();

      // 3. Expired consumed tx_guard alongside active payment_state poll:
      // tx_guard is pruned, while payment_state poll alarm remains scheduled (~5s ahead, NOT deleted!)
      await instance.track({
        paymentId: "pay_active_poll",
        checkStatusUrl: "https://relay.example/payment/pay_active_poll",
        payerAddress: "ST_BUYER",
        route: "/paid",
        tokenType: "STX",
      });
      await instance.markTxConsumed({
        txHash: "tx_alarm_consumed",
        relayPaymentId: "pay_consumed_old",
        txid: "0xold",
      });
      db.query("UPDATE tx_guard SET consumed_at = ?, updated_at = ? WHERE id = 1").run(
        Date.now() - TX_CONSUMED_TTL_MS - 5000,
        Date.now() - TX_CONSUMED_TTL_MS - 5000
      );

      await instance.alarm();
      expect(await instance.getTxGuard()).toBeNull();
      const snap = await instance.status();
      expect(snap?.status).toBe("queued");
      expect(snap?.pollCount).toBe(1);
      expect(getAlarm()).not.toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
