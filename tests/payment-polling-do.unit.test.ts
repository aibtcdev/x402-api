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

import { describe, expect, test } from "bun:test";
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
