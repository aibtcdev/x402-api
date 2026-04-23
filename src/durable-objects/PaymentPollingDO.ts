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

    // Schedule first poll in 5 seconds (only if no alarm is already set)
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + 5_000);
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
    _paymentId: string,
    checkStatusUrl: string
  ): Promise<{
    status: string;
    terminalReason?: string;
    txid?: string;
    confirmedAt?: string;
  }> {
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
}
