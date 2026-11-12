/**
 * PaymentPollingDO — Alarm-based payment status tracker
 *
 * One DO instance per paymentId. Persists payment state in SQLite, polls the
 * relay via HTTP (Phase 4) until terminal, and derives structured hints for
 * callers. Designed so swapping HTTP polling to RPC (issue #87) is a one-line
 * change inside `_fetchStatus()`.
 *
 * Instance lifecycle:
 *   1. Middleware calls track() after a successful submitPayment.
 *   2. Alarm fires every N seconds (exponential backoff) and calls poll().
 *   3. poll() calls _fetchStatus() — the single relay-contact seam.
 *   4. Callers hit GET /payment-status/:paymentId → status() for cached state.
 *   5. Phase 6 calls derivedHints() for retryable/nextSteps on error responses.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import { HttpPaymentStatusResponseSchema } from "../services/payment-contract";
import { computeDerivedHints } from "../utils/payment-hints";
import type { DerivedHints } from "../utils/payment-hints";

// =============================================================================
// Public Types
// =============================================================================

export interface PaymentTrackInput {
  paymentId: string;       // pay_ prefix from relay submitPayment
  checkStatusUrl: string;  // URL from relay submitPayment accepted response
  payerAddress: string;    // Stacks address that paid
  route: string;           // e.g. "/hashing/sha256"
  tokenType: string;       // "STX" | "sBTC" | "USDCx"
}

export interface PaymentStatusSnapshot {
  paymentId: string;
  status: string;            // TrackedPaymentState
  terminalReason?: string;   // TerminalReason if terminal
  txid?: string;
  confirmedAt?: string;
  checkStatusUrl: string;
  polledAt: string;          // ISO datetime of last poll
  pollCount: number;
}

export interface TxGuardRecord {
  txHash: string;
  relayPaymentId?: string;
  expectedRecipient?: string;
  minAmount?: string;
  asset?: string;
  network?: string;
  verifiedPayer?: string;
  requestBindingHash?: string;
  boundAt?: number;
  claimId?: string;
  claimExpiresAt?: number;
  consumed: boolean;
  consumedAt?: number;
  consumedTxid?: string;
  updatedAt: number;
}

export interface ClaimTxInput {
  txHash: string;
  claimId: string;
  expectedRecipient: string;
  minAmount: string;
  asset: string;
  network: string;
  verifiedPayer?: string;
  requestBindingHash: string;
  ttlMs?: number;
}

export type ClaimTxResult =
  | { status: "claimed"; record: TxGuardRecord }
  | { status: "consumed"; record: TxGuardRecord }
  | { status: "bound"; record: TxGuardRecord }
  | { status: "in_progress"; record: TxGuardRecord };

export interface BindTxPaymentInput {
  txHash: string;
  relayPaymentId: string;
  expectedRecipient: string;
  minAmount: string;
  asset: string;
  network: string;
  verifiedPayer?: string;
  requestBindingHash: string;
  boundAt?: number;
  claimId?: string;
}

export interface MarkTxConsumedInput {
  txHash: string;
  relayPaymentId?: string;
  txid?: string;
  expectedRecipient?: string;
  minAmount?: string;
  asset?: string;
  network?: string;
  verifiedPayer?: string;
}

// Re-export from payment-hints for callers that import from this module
export type { DerivedHints } from "../utils/payment-hints";
export { computeDerivedHints } from "../utils/payment-hints";

// =============================================================================
// Internal Constants
// =============================================================================

/** Terminal states where polling stops. */
const TERMINAL_STATUSES = new Set([
  "confirmed",
  "failed",
  "replaced",
  "not_found",
]);

/** Max polling duration: 10 minutes. After this we mark internal_error. */
const MAX_POLL_DURATION_MS = 10 * 60 * 1000;

/** TTL for an in-flight submitPayment claim before a binding or release is recorded. */
export const TX_CLAIM_TTL_MS = 30_000;

/** Retention window for unconsumed bound tx_guard rows before alarm cleanup. */
export const TX_BOUND_TTL_MS = 60 * 60 * 1_000;

/** Retention window for consumed tx_guard rows (replay protection) before alarm cleanup. */
export const TX_CONSUMED_TTL_MS = 24 * 60 * 60 * 1_000;

/** Backoff schedule: poll count → delay in ms before next alarm. */
function nextAlarmDelayMs(pollCount: number): number {
  if (pollCount < 3) return 5_000;
  if (pollCount < 6) return 15_000;
  return 60_000;
}

// =============================================================================
// SQLite Schema SQL
// =============================================================================

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS payment_state (
    payment_id       TEXT PRIMARY KEY,
    check_status_url TEXT NOT NULL,
    payer_address    TEXT NOT NULL,
    route            TEXT NOT NULL,
    token_type       TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'queued',
    terminal_reason  TEXT,
    txid             TEXT,
    confirmed_at     TEXT,
    polled_at        TEXT NOT NULL,
    poll_count       INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    is_terminal      INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS tx_guard (
    id                   INTEGER PRIMARY KEY CHECK (id = 1),
    tx_hash              TEXT NOT NULL,
    relay_payment_id     TEXT,
    expected_recipient   TEXT,
    min_amount           TEXT,
    asset                TEXT,
    network              TEXT,
    verified_payer       TEXT,
    request_binding_hash TEXT,
    bound_at             INTEGER,
    claim_id             TEXT,
    claim_expires_at     INTEGER,
    consumed             INTEGER NOT NULL DEFAULT 0,
    consumed_at          INTEGER,
    consumed_txid        TEXT,
    updated_at           INTEGER NOT NULL
  );
`;

// =============================================================================
// PaymentPollingDO
// =============================================================================

export class PaymentPollingDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    // Initialize schema synchronously before any method runs
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(SCHEMA_SQL);
      const cols = new Set(
        [...this.sql.exec("PRAGMA table_info(tx_guard)")].map(
          (r) => (r as Record<string, unknown>).name as string
        )
      );
      if (!cols.has("claim_id")) {
        this.sql.exec("ALTER TABLE tx_guard ADD COLUMN claim_id TEXT");
      }
      if (!cols.has("claim_expires_at")) {
        this.sql.exec("ALTER TABLE tx_guard ADD COLUMN claim_expires_at INTEGER");
      }
    });
  }

  // ---------------------------------------------------------------------------
  // track() — register a new payment for polling
  // ---------------------------------------------------------------------------

  /**
   * Register a new payment for polling. Called by middleware immediately after
   * a successful submitPayment() that returns accepted:true with a paymentId.
   * Schedules the first alarm to fire after 5 seconds.
   *
   * Idempotent: if called again for the same paymentId, it is a no-op if
   * already tracking (prevents double-registration from retried requests).
   */
  async track(input: PaymentTrackInput): Promise<void> {
    const now = new Date().toISOString();

    this.sql.exec(
      `
      INSERT INTO payment_state
        (payment_id, check_status_url, payer_address, route, token_type,
         status, polled_at, poll_count, created_at, is_terminal)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?, 0)
      ON CONFLICT (payment_id) DO NOTHING
      `,
      input.paymentId,
      input.checkStatusUrl,
      input.payerAddress,
      input.route,
      input.tokenType,
      now,
      now
    );

    // Schedule first poll in 5 seconds (or pull forward if a distant tx_guard alarm is set)
    const targetPollAt = Date.now() + 5_000;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > targetPollAt) {
      await this.ctx.storage.setAlarm(targetPollAt);
    }
  }

  // ---------------------------------------------------------------------------
  // poll() — fetch current status and update DB
  // ---------------------------------------------------------------------------

  /**
   * Poll the relay for current payment status and persist the result.
   * Called by the alarm handler.
   *
   * SWAP POINT FOR #87: Replace `_fetchStatus(paymentId, checkStatusUrl)` below
   * with `env.X402_RELAY.checkPayment(paymentId)` once the service binding is
   * configured. The `poll()` signature does NOT change.
   */
  async poll(): Promise<PaymentStatusSnapshot | null> {
    const rows = [...this.sql.exec(
      "SELECT * FROM payment_state WHERE is_terminal = 0 LIMIT 1"
    )];

    if (rows.length === 0) {
      // Nothing to poll (already terminal or never tracked)
      return null;
    }

    const row = rows[0] as Record<string, unknown>;
    const paymentId = row.payment_id as string;
    const checkStatusUrl = row.check_status_url as string;
    const pollCount = (row.poll_count as number) + 1;
    const createdAt = row.created_at as string;
    const now = new Date().toISOString();

    // Check max poll duration — declare timeout
    const ageMs = Date.now() - new Date(createdAt).getTime();
    if (ageMs > MAX_POLL_DURATION_MS) {
      return this._markTerminal(paymentId, "failed", "internal_error", undefined, now, pollCount, checkStatusUrl);
    }

    let statusData: Awaited<ReturnType<typeof this._fetchStatus>>;
    try {
      statusData = await this._fetchStatus(paymentId, checkStatusUrl);
    } catch {
      // Transient network error — reschedule and return cached state
      await this._reschedule(pollCount);
      return this._readSnapshot(paymentId);
    }

    const { status, terminalReason, txid, confirmedAt } = statusData;
    const isTerminal = TERMINAL_STATUSES.has(status) ? 1 : 0;

    this.sql.exec(
      `
      UPDATE payment_state SET
        status          = ?,
        terminal_reason = ?,
        txid            = ?,
        confirmed_at    = ?,
        polled_at       = ?,
        poll_count      = ?,
        is_terminal     = ?
      WHERE payment_id = ?
      `,
      status,
      terminalReason ?? null,
      txid ?? null,
      confirmedAt ?? null,
      now,
      pollCount,
      isTerminal,
      paymentId
    );

    if (!isTerminal) {
      await this._reschedule(pollCount);
    }

    return {
      paymentId,
      status,
      terminalReason,
      txid,
      confirmedAt,
      checkStatusUrl,
      polledAt: now,
      pollCount,
    };
  }

  // ---------------------------------------------------------------------------
  // status() — return cached state without hitting relay
  // ---------------------------------------------------------------------------

  /**
   * Return the latest cached status. Fast path — no relay call.
   * Used by GET /payment-status/:paymentId route.
   */
  async status(): Promise<PaymentStatusSnapshot | null> {
    const rows = [...this.sql.exec("SELECT * FROM payment_state LIMIT 1")];
    if (rows.length === 0) return null;
    return this._rowToSnapshot(rows[0] as Record<string, unknown>);
  }

  // ---------------------------------------------------------------------------
  // derivedHints() — compute hints from terminal state
  // ---------------------------------------------------------------------------

  /**
   * Derive structured error hints from current terminal state.
   * Returns null if payment is not yet terminal.
   * Used by Phase 6 error-response shape.
   */
  async derivedHints(): Promise<DerivedHints | null> {
    const snap = await this.status();
    if (!snap) return null;
    return computeDerivedHints(snap.status, snap.terminalReason);
  }

  // ---------------------------------------------------------------------------
  // alarm() — called by Cloudflare runtime on schedule
  // ---------------------------------------------------------------------------

  async alarm(): Promise<void> {
    try {
      await this.poll();
    } catch (err) {
      console.error("[PaymentPollingDO] alarm poll error:", err);
    }
    try {
      await this._cleanupExpiredTxGuard();
    } catch (err) {
      console.error("[PaymentPollingDO] alarm tx_guard cleanup error:", err);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetch payment status from the relay.
   *
   * #87 SWAP POINT: This is the single place that contacts the relay.
   * Phase 4: HTTP GET to checkStatusUrl.
   * Phase #87: Replace with `return await this.env.X402_RELAY.checkPayment(paymentId)`.
   */
  private async _fetchStatus(
    paymentId: string,
    checkStatusUrl: string
  ): Promise<{
    status: string;
    terminalReason?: string;
    txid?: string;
    confirmedAt?: string;
  }> {
    if (this.env.X402_RELAY) {
      const rpcStatus = await this.env.X402_RELAY.checkPayment(paymentId);
      const parsedRpc = HttpPaymentStatusResponseSchema.safeParse(rpcStatus);
      if (!parsedRpc.success) {
        throw new Error(`relay RPC returned invalid status payload: ${parsedRpc.error.message}`);
      }
      return {
        status: parsedRpc.data.status,
        terminalReason: parsedRpc.data.terminalReason,
        txid: parsedRpc.data.txid,
        confirmedAt: parsedRpc.data.confirmedAt,
      };
    }

    const response = await fetch(checkStatusUrl, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`relay status fetch failed: HTTP ${response.status}`);
    }

    const raw = await response.json();
    const parsed = HttpPaymentStatusResponseSchema.safeParse(raw);

    if (!parsed.success) {
      throw new Error(`relay returned invalid status payload: ${parsed.error.message}`);
    }

    const data = parsed.data;
    return {
      status: data.status,
      terminalReason: data.terminalReason,
      txid: data.txid,
      confirmedAt: data.confirmedAt,
    };
  }

  /** Schedule the next alarm using exponential backoff. */
  private async _reschedule(pollCount: number): Promise<void> {
    const delayMs = nextAlarmDelayMs(pollCount);
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  /** Mark payment as terminal (used for timeout case). */
  private _markTerminal(
    paymentId: string,
    status: string,
    terminalReason: string,
    txid: string | undefined,
    now: string,
    pollCount: number,
    checkStatusUrl: string
  ): PaymentStatusSnapshot {
    this.sql.exec(
      `
      UPDATE payment_state SET
        status          = ?,
        terminal_reason = ?,
        polled_at       = ?,
        poll_count      = ?,
        is_terminal     = 1
      WHERE payment_id = ?
      `,
      status,
      terminalReason,
      now,
      pollCount,
      paymentId
    );

    return {
      paymentId,
      status,
      terminalReason,
      txid,
      checkStatusUrl,
      polledAt: now,
      pollCount,
    };
  }

  /** Read snapshot from DB row — null safe conversion. */
  private _readSnapshot(paymentId: string): PaymentStatusSnapshot | null {
    const rows = [...this.sql.exec(
      "SELECT * FROM payment_state WHERE payment_id = ? LIMIT 1",
      paymentId
    )];
    if (rows.length === 0) return null;
    return this._rowToSnapshot(rows[0] as Record<string, unknown>);
  }

  /** Convert a DB row to a PaymentStatusSnapshot. */
  private _rowToSnapshot(row: Record<string, unknown>): PaymentStatusSnapshot {
    return {
      paymentId: row.payment_id as string,
      status: row.status as string,
      terminalReason: (row.terminal_reason as string | null) ?? undefined,
      txid: (row.txid as string | null) ?? undefined,
      confirmedAt: (row.confirmed_at as string | null) ?? undefined,
      checkStatusUrl: row.check_status_url as string,
      polledAt: row.polled_at as string,
      pollCount: row.poll_count as number,
    };
  }

  // ---------------------------------------------------------------------------
  // Cross-isolate txHash guard methods (keyed by idFromName("tx:" + txHash))
  // ---------------------------------------------------------------------------

  /** Synchronous internal read for tx_guard so guard checks/writes run without yielding. */
  private _readTxGuard(): TxGuardRecord | null {
    const rows = [...this.sql.exec("SELECT * FROM tx_guard WHERE id = 1 LIMIT 1")];
    if (rows.length === 0) return null;
    return this._rowToTxGuard(rows[0] as Record<string, unknown>);
  }

  private _hasActivePaymentPoll(): boolean {
    const rows = [...this.sql.exec("SELECT 1 FROM payment_state WHERE is_terminal = 0 LIMIT 1")];
    return rows.length > 0;
  }

  private _getTxGuardExpiresAt(record: TxGuardRecord): number {
    if (record.consumed) {
      return (record.consumedAt ?? record.updatedAt) + TX_CONSUMED_TTL_MS;
    }
    if (record.relayPaymentId) {
      return (record.boundAt ?? record.updatedAt) + TX_BOUND_TTL_MS;
    }
    return record.claimExpiresAt ?? record.updatedAt + TX_CLAIM_TTL_MS;
  }

  private async _scheduleTxGuardAlarm(targetTimestampMs: number): Promise<void> {
    if (this._hasActivePaymentPoll()) {
      return;
    }
    await this.ctx.storage.setAlarm(targetTimestampMs);
  }

  private async _clearAlarmIfNoActivePoll(): Promise<void> {
    if (!this._hasActivePaymentPoll()) {
      await this.ctx.storage.deleteAlarm();
    }
  }

  private async _cleanupExpiredTxGuard(now = Date.now()): Promise<boolean> {
    const existing = this._readTxGuard();
    if (!existing) {
      return false;
    }
    const expiresAt = this._getTxGuardExpiresAt(existing);
    if (now >= expiresAt) {
      this.sql.exec("DELETE FROM tx_guard WHERE id = 1");
      await this._clearAlarmIfNoActivePoll();
      return true;
    }
    if (!this._hasActivePaymentPoll()) {
      const currentAlarm = await this.ctx.storage.getAlarm();
      if (currentAlarm === null || currentAlarm <= now) {
        await this.ctx.storage.setAlarm(expiresAt);
      }
    }
    return false;
  }

  /** Read bound + consumed state for this txHash DO instance, pruning expired rows. */
  async getTxGuard(): Promise<TxGuardRecord | null> {
    const existing = this._readTxGuard();
    if (!existing) return null;
    if (Date.now() >= this._getTxGuardExpiresAt(existing)) {
      this.sql.exec("DELETE FROM tx_guard WHERE id = 1");
      await this._clearAlarmIfNoActivePoll();
      return null;
    }
    return existing;
  }

  /**
   * Atomically claim an unclaimed txHash before invoking relay submitPayment.
   * Prevents concurrent cold-isolate TOCTOU duplicate submissions while allowing
   * stale claims to expire after TTL.
   */
  async claimTx(input: ClaimTxInput): Promise<ClaimTxResult> {
    const now = Date.now();
    let existing = this._readTxGuard();
    if (existing && now >= this._getTxGuardExpiresAt(existing)) {
      this.sql.exec("DELETE FROM tx_guard WHERE id = 1");
      existing = null;
    }

    if (existing) {
      if (existing.consumed) {
        return { status: "consumed", record: existing };
      }
      if (existing.relayPaymentId) {
        return { status: "bound", record: existing };
      }
      if (existing.claimId && existing.claimId !== input.claimId) {
        return { status: "in_progress", record: existing };
      }
    }

    const ttlMs = input.ttlMs ?? TX_CLAIM_TTL_MS;
    const claimExpiresAt = now + ttlMs;
    const verifiedPayer = input.verifiedPayer || existing?.verifiedPayer || null;

    this.sql.exec(
      `
      INSERT INTO tx_guard
        (id, tx_hash, relay_payment_id, expected_recipient, min_amount, asset, network,
         verified_payer, request_binding_hash, bound_at, claim_id, claim_expires_at,
         consumed, consumed_at, consumed_txid, updated_at)
      VALUES (1, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, NULL, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET
        expected_recipient   = excluded.expected_recipient,
        min_amount           = excluded.min_amount,
        asset                = excluded.asset,
        network              = excluded.network,
        verified_payer       = COALESCE(excluded.verified_payer, tx_guard.verified_payer),
        request_binding_hash = excluded.request_binding_hash,
        claim_id             = excluded.claim_id,
        claim_expires_at     = excluded.claim_expires_at,
        updated_at           = excluded.updated_at
      WHERE tx_guard.consumed = 0 AND tx_guard.relay_payment_id IS NULL
      `,
      input.txHash,
      input.expectedRecipient,
      input.minAmount,
      input.asset,
      input.network,
      verifiedPayer,
      input.requestBindingHash,
      input.claimId,
      claimExpiresAt,
      now
    );

    const record = this._readTxGuard()!;
    await this._scheduleTxGuardAlarm(claimExpiresAt);
    return { status: "claimed", record };
  }

  /**
   * Release an in-progress claim if submitPayment was rejected or threw before binding.
   * Strict no-op if already bound, consumed, or held by another claimId.
   */
  async releaseTxClaim(claimId: string): Promise<void> {
    if (!claimId) return;
    const existing = this._readTxGuard();
    if (!existing || existing.consumed || existing.relayPaymentId) {
      return;
    }
    if (existing.claimId !== claimId) {
      return;
    }
    this.sql.exec(
      "DELETE FROM tx_guard WHERE id = 1 AND consumed = 0 AND relay_payment_id IS NULL AND claim_id = ?",
      claimId
    );
    await this._clearAlarmIfNoActivePoll();
  }

  /**
   * Persist bound relay payment metadata for this txHash across Worker isolates.
   * First-writer-wins: preserves existing active unconsumed bindings (including
   * min_amount and request_binding_hash) and never clears consumed=1.
   */
  async bindTxPayment(input: BindTxPaymentInput): Promise<TxGuardRecord> {
    const now = Date.now();
    let existing = this._readTxGuard();
    if (existing && now >= this._getTxGuardExpiresAt(existing)) {
      this.sql.exec("DELETE FROM tx_guard WHERE id = 1");
      existing = null;
    }
    if (existing?.consumed) {
      return existing;
    }
    if (existing?.relayPaymentId) {
      if (!existing.verifiedPayer && input.verifiedPayer) {
        this.sql.exec(
          "UPDATE tx_guard SET verified_payer = ?, updated_at = ? WHERE id = 1 AND consumed = 0",
          input.verifiedPayer,
          now
        );
        return this._readTxGuard()!;
      }
      return existing;
    }
    if (existing?.claimId && existing.claimId !== input.claimId) {
      return existing;
    }

    const boundAt = input.boundAt ?? now;
    const verifiedPayer = input.verifiedPayer || existing?.verifiedPayer || null;

    this.sql.exec(
      `
      INSERT INTO tx_guard
        (id, tx_hash, relay_payment_id, expected_recipient, min_amount, asset, network,
         verified_payer, request_binding_hash, bound_at, claim_id, claim_expires_at,
         consumed, consumed_at, consumed_txid, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET
        relay_payment_id     = CASE WHEN tx_guard.consumed = 1 OR tx_guard.relay_payment_id IS NOT NULL THEN tx_guard.relay_payment_id ELSE excluded.relay_payment_id END,
        expected_recipient   = CASE WHEN tx_guard.consumed = 1 OR tx_guard.relay_payment_id IS NOT NULL THEN tx_guard.expected_recipient ELSE excluded.expected_recipient END,
        min_amount           = CASE WHEN tx_guard.consumed = 1 OR tx_guard.relay_payment_id IS NOT NULL THEN tx_guard.min_amount ELSE excluded.min_amount END,
        asset                = CASE WHEN tx_guard.consumed = 1 OR tx_guard.relay_payment_id IS NOT NULL THEN tx_guard.asset ELSE excluded.asset END,
        network              = CASE WHEN tx_guard.consumed = 1 OR tx_guard.relay_payment_id IS NOT NULL THEN tx_guard.network ELSE excluded.network END,
        verified_payer       = COALESCE(tx_guard.verified_payer, excluded.verified_payer),
        request_binding_hash = CASE WHEN tx_guard.consumed = 1 OR tx_guard.relay_payment_id IS NOT NULL THEN tx_guard.request_binding_hash ELSE excluded.request_binding_hash END,
        bound_at             = CASE WHEN tx_guard.consumed = 1 OR tx_guard.relay_payment_id IS NOT NULL THEN tx_guard.bound_at ELSE excluded.bound_at END,
        claim_id             = NULL,
        claim_expires_at     = NULL,
        updated_at           = excluded.updated_at
      `,
      input.txHash,
      input.relayPaymentId,
      input.expectedRecipient,
      input.minAmount,
      input.asset,
      input.network,
      verifiedPayer,
      input.requestBindingHash,
      boundAt,
      now
    );

    const record = this._readTxGuard()!;
    await this._scheduleTxGuardAlarm(boundAt + TX_BOUND_TTL_MS);
    return record;
  }

  /**
   * Clear pending bound metadata after a terminal non-grace failure or payer mismatch.
   * Strict no-op if consumed=1 or if relay_payment_id does not match expectedRelayPaymentId.
   */
  async clearBoundTx(expectedRelayPaymentId: string): Promise<void> {
    if (!expectedRelayPaymentId) return;
    const existing = this._readTxGuard();
    if (!existing || existing.consumed) return;
    if (existing.relayPaymentId !== expectedRelayPaymentId) return;
    this.sql.exec(
      "DELETE FROM tx_guard WHERE id = 1 AND consumed = 0 AND relay_payment_id = ?",
      expectedRelayPaymentId
    );
    await this._clearAlarmIfNoActivePoll();
  }

  /**
   * Atomically mark a txHash as consumed before delivering the paid response.
   * Returns alreadyConsumed=true if another request/isolate already consumed it.
   */
  async markTxConsumed(
    input: MarkTxConsumedInput
  ): Promise<{ alreadyConsumed: boolean; record: TxGuardRecord }> {
    const existing = this._readTxGuard();
    if (existing?.consumed) {
      return { alreadyConsumed: true, record: existing };
    }

    const now = Date.now();
    this.sql.exec(
      `
      INSERT INTO tx_guard
        (id, tx_hash, relay_payment_id, expected_recipient, min_amount, asset, network,
         verified_payer, request_binding_hash, bound_at, claim_id, claim_expires_at,
         consumed, consumed_at, consumed_txid, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, 1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        relay_payment_id   = COALESCE(tx_guard.relay_payment_id, excluded.relay_payment_id),
        expected_recipient = COALESCE(tx_guard.expected_recipient, excluded.expected_recipient),
        min_amount         = COALESCE(tx_guard.min_amount, excluded.min_amount),
        asset              = COALESCE(tx_guard.asset, excluded.asset),
        network            = COALESCE(tx_guard.network, excluded.network),
        verified_payer     = COALESCE(tx_guard.verified_payer, excluded.verified_payer),
        claim_id           = NULL,
        claim_expires_at   = NULL,
        consumed           = 1,
        consumed_at        = COALESCE(tx_guard.consumed_at, excluded.consumed_at),
        consumed_txid      = COALESCE(tx_guard.consumed_txid, excluded.consumed_txid),
        updated_at         = excluded.updated_at
      `,
      input.txHash,
      input.relayPaymentId ?? null,
      input.expectedRecipient ?? null,
      input.minAmount ?? null,
      input.asset ?? null,
      input.network ?? null,
      input.verifiedPayer ?? null,
      existing?.boundAt ?? now,
      now,
      input.txid ?? null,
      now
    );

    const updated = this._readTxGuard()!;
    await this._scheduleTxGuardAlarm(now + TX_CONSUMED_TTL_MS);
    return { alreadyConsumed: false, record: updated };
  }

  private _rowToTxGuard(row: Record<string, unknown>): TxGuardRecord {
    return {
      txHash: row.tx_hash as string,
      relayPaymentId: (row.relay_payment_id as string | null) ?? undefined,
      expectedRecipient: (row.expected_recipient as string | null) ?? undefined,
      minAmount: (row.min_amount as string | null) ?? undefined,
      asset: (row.asset as string | null) ?? undefined,
      network: (row.network as string | null) ?? undefined,
      verifiedPayer: (row.verified_payer as string | null) ?? undefined,
      requestBindingHash: (row.request_binding_hash as string | null) ?? undefined,
      boundAt: typeof row.bound_at === "number" ? row.bound_at : undefined,
      claimId: (row.claim_id as string | null) ?? undefined,
      claimExpiresAt: typeof row.claim_expires_at === "number" ? row.claim_expires_at : undefined,
      consumed: row.consumed === 1,
      consumedAt: typeof row.consumed_at === "number" ? row.consumed_at : undefined,
      consumedTxid: (row.consumed_txid as string | null) ?? undefined,
      updatedAt: row.updated_at as number,
    };
  }
}
