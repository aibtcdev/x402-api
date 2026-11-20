/**
 * x402 Payment Middleware (V2 Protocol)
 *
 * Verifies x402 payments for API requests using the x402-stacks library
 * or the bound X402_RELAY WorkerEntrypoint RPC service.
 * Implements Coinbase-compatible x402 v2 protocol.
 *
 * Payment lifecycle events emitted:
 *   payment.initiated  — settlement attempt initiated, about to submit to relay
 *   payment.pending    — relay accepted (enqueued) but payment is still in-flight
 *   payment.confirmed  — relay settled and confirmed on-chain with verified origin
 *   payment.failed     — relay rejected with a terminal failure reason
 *   payment.replaced   — payment was replaced by another tx (nonce race)
 */

import type { Context, MiddlewareHandler } from "hono";
import {
  X402PaymentVerifier,
  networkToCAIP2,
  X402_HEADERS,
  X402_ERROR_CODES,
} from "x402-stacks";
import type {
  PaymentRequiredV2,
  PaymentRequirementsV2,
  PaymentPayloadV2,
} from "x402-stacks";
import {
  deserializeTransaction,
  serializePayload,
  addressHashModeToVersion,
  Address,
  AuthType,
} from "@stacks/transactions";
import { stripHexPrefix } from "../utils/encoding";
import { HiroClient } from "../services/hiro";
import type {
  RpcErrorCode,
  SettleResult,
  TerminalReason,
} from "../services/payment-contract";
import type {
  TxGuardRecord,
  ClaimTxInput,
  ClaimTxResult,
  BindTxPaymentInput,
  ClearBoundTxReason,
  ClearBoundTxResult,
  MarkTxConsumedInput,
} from "../durable-objects/PaymentPollingDO";
import type {
  Env,
  AppVariables,
  Logger,
  TokenType,
  TokenContract,
  PricingTier,
  PriceEstimate,
  X402Context,
  ChatCompletionRequest,
  RelayRPC,
  RelayCheckPaymentResult,
} from "../types";
import {
  validateTokenType,
  getFixedTierEstimate,
  estimateChatPayment,
} from "../services/pricing";
import { lookupModel } from "../services/model-cache";
import { getEndpointMetadata, buildBazaarExtension } from "../bazaar";
import {
  derivePaymentInstability,
  logPaymentEvent,
} from "../utils/payment-observability";
import { computeDerivedHints } from "../utils/payment-hints";
import type { DerivedHints } from "../utils/payment-hints";
import {
  canRetrySamePaymentResubmission,
  classifySenderNonceState,
  isMissingSenderNonceGap,
  isRelayRetryableTerminalReason,
  MAX_NONCE_GUARD_MISSING_GAP_RETRIES,
  MAX_NONCE_GUARD_UNAVAILABLE_RETRIES,
  NOT_FOUND_ENQUEUE_GRACE_MS,
} from "../utils/payment-status";

export { NOT_FOUND_ENQUEUE_GRACE_MS };

// =============================================================================
// Types
// =============================================================================

export type PayerNonceUnavailableReason =
  | "nonce_state_unknown"
  | "consumed_tx_unindexed"
  | "consumed_tx_unparseable";

export type PayerNoncePendingReason = "mempool" | "missing_nonce_gap";

export type PayerNonceGuardVerdict =
  | { outcome: "unused" }
  | { outcome: "pending"; reason?: PayerNoncePendingReason }
  | { outcome: "confirmed"; txid: string }
  | { outcome: "replaced" }
  | { outcome: "aborted" }
  | { outcome: "unavailable"; reason?: PayerNonceUnavailableReason };

export type CheckPayerNonceBeforeNewPaymentFn = (input: {
  payerAddress: string;
  txNonce: number;
  cleanTxHex: string;
  network: "mainnet" | "testnet";
  hiroApiKey?: string;
  log: Logger;
}) => Promise<PayerNonceGuardVerdict>;

export interface X402MiddlewareOptions {
  /** Pricing tier for fixed pricing endpoints */
  tier?: PricingTier;
  /** Set to true for dynamic pricing (LLM endpoints) */
  dynamic?: boolean;
  /** Custom price estimator for dynamic pricing */
  estimator?: (body: unknown, tokenType: TokenType, log: Logger) => PriceEstimate;
  /** Max checkPayment poll attempts per request after RPC enqueue (default: 15) */
  rpcPollMaxAttempts?: number;
  /** Delay in ms between checkPayment poll attempts (default: 1000ms) */
  rpcPollIntervalMs?: number;
  /** Optional override for the pre-`start_new_payment` payer nonce guard (defaults to Hiro API lookup) */
  checkPayerNonceBeforeNewPayment?: CheckPayerNonceBeforeNewPaymentFn;
}

export interface VerifiedTransactionOrigin {
  cleanHex: string;
  payerAddress: string;
  authType: number;
  nonce: string;
}

interface BoundRpcPayment {
  relayPaymentId: string;
  bindingId?: string;
  callerSuppliedPaymentId?: string;
  requestCorrelationId: string;
  requestBindingHash: string;
  txHash: string;
  verifiedPayer: string;
  checkStatusUrl: string;
  expectedRecipient: string;
  minAmount: string;
  asset: string;
  network: string;
  createdAt: number;
  countedTerminalRelease?: boolean;
}

interface RelayBoundStore {
  byRelayId: Map<string, BoundRpcPayment>;
  byCorrelationId: Map<string, BoundRpcPayment>;
  byTxHash: Map<string, BoundRpcPayment>;
}

// =============================================================================
// Constants, In-Flight Bound Store & Consumed Payment Replay Guard
// =============================================================================

const IN_FLIGHT_PUBLIC_STATUSES = new Set([
  "queued",
  "broadcasting",
  "mempool",
]);

function normalizeOptionalPublicPaymentStatus(status?: string): string | undefined {
  if (status === "submitted" || status === "queued_with_warning") {
    return "queued";
  }
  return status;
}

function normalizePublicPaymentStatus(status?: string): string {
  return normalizeOptionalPublicPaymentStatus(status) || "queued";
}

const TERMINAL_FAILURE_RPC_STATUSES = new Set([
  "failed",
  "replaced",
  "not_found",
]);

const RPC_CODE_TO_TERMINAL_REASON: Record<RpcErrorCode, TerminalReason | null> = {
  INVALID_TRANSACTION: "invalid_transaction",
  NOT_SPONSORED: "not_sponsored",
  SENDER_NONCE_STALE: "sender_nonce_stale",
  SENDER_NONCE_DUPLICATE: "sender_nonce_duplicate",
  SENDER_NONCE_GAP: "sender_nonce_gap",
  NONCE_CONFLICT: "sponsor_nonce_conflict",
  SPONSOR_NONCE_STALE: "sponsor_nonce_conflict",
  SPONSOR_NONCE_DUPLICATE: "sponsor_nonce_conflict",
  BROADCAST_FAILED: "broadcast_failure",
  TX_BROADCAST_ERROR: "broadcast_failure",
  SETTLEMENT_FAILED: "chain_abort",
  INTERNAL_ERROR: "internal_error",
  // Wallet balance rejection maps directly to 402 X402_ERROR_CODES.INSUFFICIENT_FUNDS rather than a TerminalReason.
  INSUFFICIENT_FUNDS: null,
  CLIENT_NONCE_CONFLICT: "sender_nonce_duplicate",
  CLIENT_BAD_NONCE: "sender_nonce_stale",
  TOO_MUCH_CHAINING: "origin_chaining_limit",
  SPONSOR_EXHAUSTED: "sponsor_exhausted",
  ORIGIN_CHAINING_LIMIT: "origin_chaining_limit",
  BROADCAST_RATE_LIMITED: "broadcast_rate_limited",
  SENDER_HAND_EXPIRED: "sender_hand_expired",
  NONCE_OCCUPIED: "sender_nonce_duplicate",
  PAYMENT_IDENTIFIER_CONFLICT: "unknown_payment_identity",
};

/**
 * Compatibility fallback for relay error codes emitted before they are added to
 * `@aibtc/tx-schemas` `RPC_ERROR_CODES` (e.g. `QUEUE_UNAVAILABLE` pre-enqueue
 * backpressure or `BROADCAST_EXHAUSTED` from `finalizeExhaustedPayment`).
 */
const COMPAT_RELAY_CODE_TO_TERMINAL_REASON: Partial<Record<string, TerminalReason>> = {
  QUEUE_UNAVAILABLE: "queue_unavailable",
  BROADCAST_EXHAUSTED: "internal_error",
};

function mapRelayErrorCodeToTerminalReason(code: string | undefined): TerminalReason | undefined {
  if (!code) return undefined;
  if (Object.hasOwn(RPC_CODE_TO_TERMINAL_REASON, code)) {
    return RPC_CODE_TO_TERMINAL_REASON[code as RpcErrorCode] ?? undefined;
  }
  return COMPAT_RELAY_CODE_TO_TERMINAL_REASON[code];
}

const BOUND_RPC_STORES = new WeakMap<object, RelayBoundStore>();

const MAX_CONSUMED_PAYMENTS_PER_SET = 10_000;
const MAX_BOUND_PAYMENTS_PER_STORE = 5_000;
const BOUND_PAYMENT_TTL_MS = 10 * 60 * 1_000;

/**
 * Per-isolate bounded fast guard tracking payments that have already been
 * confirmed and served in this Worker isolate. Cross-isolate replay of a
 * confirmed transaction is blocked durably by `PaymentPollingDO.markTxConsumed`.
 */
const CONSUMED_PAYMENTS = {
  byTxHash: new Set<string>(),
  byRelayId: new Set<string>(),
  byConfirmedTxid: new Set<string>(),
  relayIdByTxHash: new Map<string, string>(),
};

const FAILED_TX_ATTEMPTS = new Map<
  string,
  {
    count: number;
    lastFailedPaymentId?: string;
    nonceGuardUnavailable: number;
    nonceGuardGap: number;
  }
>();

function getFailedAttemptCount(txHash: string): number {
  return txHash ? (FAILED_TX_ATTEMPTS.get(txHash)?.count ?? 0) : 0;
}

function recordIsolateNonceGuardUnavailable(txHash: string): number {
  if (!txHash) {
    return 0;
  }
  const existing = FAILED_TX_ATTEMPTS.get(txHash);
  if (!existing && FAILED_TX_ATTEMPTS.size >= MAX_BOUND_PAYMENTS_PER_STORE) {
    const oldest = FAILED_TX_ATTEMPTS.keys().next().value;
    if (oldest !== undefined) {
      FAILED_TX_ATTEMPTS.delete(oldest);
    }
  }
  const nextUnavailable = (existing?.nonceGuardUnavailable ?? 0) + 1;
  FAILED_TX_ATTEMPTS.set(txHash, {
    count: existing?.count ?? 0,
    lastFailedPaymentId: existing?.lastFailedPaymentId,
    nonceGuardUnavailable: nextUnavailable,
    nonceGuardGap: 0,
  });
  return nextUnavailable;
}

function recordIsolateNonceGuardGap(txHash: string): number {
  if (!txHash) {
    return 0;
  }
  const existing = FAILED_TX_ATTEMPTS.get(txHash);
  if (!existing && FAILED_TX_ATTEMPTS.size >= MAX_BOUND_PAYMENTS_PER_STORE) {
    const oldest = FAILED_TX_ATTEMPTS.keys().next().value;
    if (oldest !== undefined) {
      FAILED_TX_ATTEMPTS.delete(oldest);
    }
  }
  const nextGap = (existing?.nonceGuardGap ?? 0) + 1;
  FAILED_TX_ATTEMPTS.set(txHash, {
    count: existing?.count ?? 0,
    lastFailedPaymentId: existing?.lastFailedPaymentId,
    nonceGuardUnavailable: 0,
    nonceGuardGap: nextGap,
  });
  return nextGap;
}

function resetIsolateNonceGuardCounters(txHash: string): void {
  if (!txHash) {
    return;
  }
  const existing = FAILED_TX_ATTEMPTS.get(txHash);
  if (!existing) {
    return;
  }
  if (existing.count <= 0) {
    FAILED_TX_ATTEMPTS.delete(txHash);
    return;
  }
  FAILED_TX_ATTEMPTS.set(txHash, {
    count: existing.count,
    lastFailedPaymentId: existing.lastFailedPaymentId,
    nonceGuardUnavailable: 0,
    nonceGuardGap: 0,
  });
}

function setFailedAttemptCount(
  txHash: string,
  count: number,
  lastFailedPaymentId?: string,
  nonceGuardUnavailable?: number,
  nonceGuardGap?: number
): void {
  if (
    !txHash ||
    (count <= 0 && (nonceGuardUnavailable ?? 0) <= 0 && (nonceGuardGap ?? 0) <= 0)
  ) {
    return;
  }
  const existing = FAILED_TX_ATTEMPTS.get(txHash);
  if (!existing && FAILED_TX_ATTEMPTS.size >= MAX_BOUND_PAYMENTS_PER_STORE) {
    const oldest = FAILED_TX_ATTEMPTS.keys().next().value;
    if (oldest !== undefined) {
      FAILED_TX_ATTEMPTS.delete(oldest);
    }
  }
  FAILED_TX_ATTEMPTS.set(txHash, {
    count: Math.max(0, count),
    lastFailedPaymentId: lastFailedPaymentId ?? existing?.lastFailedPaymentId,
    nonceGuardUnavailable:
      nonceGuardUnavailable !== undefined
        ? Math.max(0, nonceGuardUnavailable)
        : (existing?.nonceGuardUnavailable ?? 0),
    nonceGuardGap:
      nonceGuardGap !== undefined
        ? Math.max(0, nonceGuardGap)
        : (existing?.nonceGuardGap ?? 0),
  });
}

function recordTerminalFailure(txHash: string, relayPaymentId?: string): void {
  if (!txHash) {
    return;
  }
  const existing = FAILED_TX_ATTEMPTS.get(txHash);
  setFailedAttemptCount(txHash, (existing?.count ?? 0) + 1, relayPaymentId);
}

function syncFailedAttemptCount(txHash: string, count: number): void {
  setFailedAttemptCount(txHash, count);
}

async function resolveSettlementAttemptId(
  baseAttemptId: string,
  failedAttempts: number
): Promise<string> {
  if (failedAttempts <= 0) {
    return baseAttemptId;
  }
  const digest = await sha256Hex(`${baseAttemptId}|retry:${failedAttempts}`);
  return `pay_${digest.slice(0, 28)}`;
}

function addBoundedSetEntry(set: Set<string>, value: string): void {
  if (set.has(value)) {
    return;
  }
  if (set.size >= MAX_CONSUMED_PAYMENTS_PER_SET) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) {
      set.delete(oldest);
    }
  }
  set.add(value);
}

function deleteBoundEntryFromStore(store: RelayBoundStore, entry: BoundRpcPayment): void {
  store.byRelayId.delete(entry.relayPaymentId);
  if (store.byCorrelationId.get(entry.requestCorrelationId) === entry) {
    store.byCorrelationId.delete(entry.requestCorrelationId);
  }
  if (store.byTxHash.get(entry.txHash) === entry) {
    store.byTxHash.delete(entry.txHash);
  }
}

function pruneRelayBoundStore(store: RelayBoundStore, now = Date.now()): void {
  for (const entry of store.byRelayId.values()) {
    if (now - entry.createdAt > BOUND_PAYMENT_TTL_MS) {
      deleteBoundEntryFromStore(store, entry);
    } else {
      break;
    }
  }
  while (store.byRelayId.size >= MAX_BOUND_PAYMENTS_PER_STORE) {
    const oldest = store.byRelayId.values().next().value;
    if (!oldest) {
      break;
    }
    deleteBoundEntryFromStore(store, oldest);
  }
}

function getRelayBoundStore(relay: RelayRPC): RelayBoundStore {
  let store = BOUND_RPC_STORES.get(relay as unknown as object);
  if (!store) {
    store = {
      byRelayId: new Map(),
      byCorrelationId: new Map(),
      byTxHash: new Map(),
    };
    BOUND_RPC_STORES.set(relay as unknown as object, store);
  } else {
    pruneRelayBoundStore(store);
  }
  return store;
}

function saveBoundPayment(relay: RelayRPC, entry: BoundRpcPayment): void {
  const store = getRelayBoundStore(relay);
  pruneRelayBoundStore(store, entry.createdAt);
  store.byRelayId.set(entry.relayPaymentId, entry);
  store.byCorrelationId.set(entry.requestCorrelationId, entry);
  store.byTxHash.set(entry.txHash, entry);
}

function removeBoundPayment(relay: RelayRPC, entry: BoundRpcPayment): void {
  const store = getRelayBoundStore(relay);
  deleteBoundEntryFromStore(store, entry);
}

function markPaymentConsumed(
  txHash: string,
  relayPaymentId?: string,
  confirmedTxid?: string,
  isRelayMintedPaymentId = true
): void {
  if (txHash) {
    FAILED_TX_ATTEMPTS.delete(txHash);
    addBoundedSetEntry(CONSUMED_PAYMENTS.byTxHash, txHash);
  }
  if (relayPaymentId && relayPaymentId.startsWith("pay_")) {
    if (isRelayMintedPaymentId) {
      addBoundedSetEntry(CONSUMED_PAYMENTS.byRelayId, relayPaymentId);
    }
    if (txHash) {
      if (!CONSUMED_PAYMENTS.relayIdByTxHash.has(txHash) && CONSUMED_PAYMENTS.relayIdByTxHash.size >= MAX_CONSUMED_PAYMENTS_PER_SET) {
        const oldest = CONSUMED_PAYMENTS.relayIdByTxHash.keys().next().value;
        if (oldest !== undefined) {
          CONSUMED_PAYMENTS.relayIdByTxHash.delete(oldest);
        }
      }
      CONSUMED_PAYMENTS.relayIdByTxHash.set(txHash, relayPaymentId);
    }
  }
  if (confirmedTxid) {
    addBoundedSetEntry(CONSUMED_PAYMENTS.byConfirmedTxid, confirmedTxid.toLowerCase());
  }
}

function isPaymentConsumed(
  txHash?: string,
  relayPaymentId?: string,
  confirmedTxid?: string
): boolean {
  if (txHash && CONSUMED_PAYMENTS.byTxHash.has(txHash)) {
    return true;
  }
  if (relayPaymentId && CONSUMED_PAYMENTS.byRelayId.has(relayPaymentId)) {
    return true;
  }
  if (confirmedTxid && CONSUMED_PAYMENTS.byConfirmedTxid.has(confirmedTxid.toLowerCase())) {
    return true;
  }
  return false;
}

// =============================================================================
// Token Contracts
// =============================================================================

const TOKEN_CONTRACTS: Record<"mainnet" | "testnet", Record<"sBTC" | "USDCx", TokenContract>> = {
  mainnet: {
    sBTC: { address: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4", name: "sbtc-token" },
    USDCx: { address: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE", name: "usdcx" },
  },
  testnet: {
    sBTC: { address: "ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT", name: "sbtc-token" },
    USDCx: { address: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM", name: "usdcx" },
  },
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Encode object to base64 JSON for headers
 */
function encodeBase64Json(obj: unknown): string {
  const json = JSON.stringify(obj, (_, value) =>
    typeof value === "bigint" ? value.toString() : value
  );
  return btoa(json);
}

/**
 * Decode base64 JSON from header
 */
function decodeBase64Json<T>(base64: string): T | null {
  try {
    const json = atob(base64);
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/**
 * Compute SHA-256 hex digest using Web Crypto API
 */
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compute a resource-server request binding digest covering HTTP method,
 * request path, query string, and request body bytes so a pending payment
 * cannot be recovered against a modified request payload or route.
 * On dynamic routes where `c.req.json()` has already parsed the body,
 * Hono 4.12.14 (`#cachedBody`) causes `c.req.arrayBuffer()` to serialize
 * `JSON.stringify(parsedBody)` rather than the original wire bytes, which
 * still matches the parsed value observed by the downstream handler.
 * Fails closed (returns null and logs a warning) if reading the body on a
 * non-GET/HEAD request fails.
 */
async function computeRequestBindingHash(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  log: Logger
): Promise<string | null> {
  const req = c.req.raw;
  const url = new URL(req.url, "http://localhost");
  const method = req.method.toUpperCase();
  let bodyHash = "";
  if (method !== "GET" && method !== "HEAD") {
    try {
      const buf = req.bodyUsed
        ? await c.req.arrayBuffer()
        : await req.clone().arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buf);
      bodyHash = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    } catch (err) {
      log.warn("Failed to read request body for x402 request binding; failing closed", {
        method,
        path: url.pathname,
        error: String(err),
      });
      return null;
    }
  }
  return sha256Hex(`${method}|${url.pathname}|${url.search}|${bodyHash}`);
}

function respondConsumedPayment(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  opts: {
    paymentId?: string;
    requestCorrelationId: string;
    asset: string;
    network: string;
  }
): Response {
  const replayHints: DerivedHints = {
    retryable: false,
    nextSteps: "start_new_payment",
  };
  c.header(X402_HEADERS.PAYMENT_RESPONSE, encodeBase64Json(replayHints));
  if (opts.paymentId) {
    c.header("X-PAYMENT-ID", opts.paymentId);
  }
  return c.json(
    {
      error: "Payment has already been settled and consumed, start a new payment flow",
      code: X402_ERROR_CODES.INVALID_TRANSACTION_STATE,
      retryable: false,
      nextSteps: "start_new_payment",
      ...(opts.paymentId ? { paymentId: opts.paymentId } : {}),
      requestCorrelationId: opts.requestCorrelationId,
      asset: opts.asset,
      network: opts.network,
      resource: c.req.path,
    },
    402
  );
}

function validateBoundPaymentForRecovery(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  entry: BoundRpcPayment,
  opts: {
    verifiedPayer?: string;
    txHash: string;
    requireTxHashMatch: boolean;
    expectedRecipient: string;
    asset: string;
    network: string;
    minAmount: string;
    allowDynamicBoundAmount?: boolean;
    requestBindingHash: string;
    requestCorrelationId: string;
  }
): Response | null {
  const payerMismatch = Boolean(
    opts.verifiedPayer && entry.verifiedPayer && opts.verifiedPayer !== entry.verifiedPayer
  );
  const txMismatch = opts.requireTxHashMatch && entry.txHash !== opts.txHash;
  if (payerMismatch || txMismatch) {
    return c.json(
      {
        error: "Bound payment origin mismatch for recovery attempt",
        code: X402_ERROR_CODES.SENDER_MISMATCH,
      },
      400
    );
  }
  if (
    entry.expectedRecipient !== opts.expectedRecipient ||
    entry.asset !== opts.asset ||
    entry.network !== opts.network
  ) {
    return c.json(
      {
        error: "Bound payment recipient or asset mismatch for recovery attempt",
        code: X402_ERROR_CODES.RECIPIENT_MISMATCH,
      },
      400
    );
  }
  const canUseDynamicBoundAmount =
    Boolean(opts.allowDynamicBoundAmount) &&
    entry.requestBindingHash === opts.requestBindingHash;
  if (!canUseDynamicBoundAmount && BigInt(entry.minAmount) < BigInt(opts.minAmount)) {
    return c.json(
      {
        error: "Payment amount below minimum required",
        code: X402_ERROR_CODES.AMOUNT_INSUFFICIENT,
        retryable: false,
        nextSteps: "start_new_payment",
        paymentId: entry.relayPaymentId,
        requestCorrelationId: opts.requestCorrelationId,
        asset: opts.asset,
        network: opts.network,
        resource: c.req.path,
      },
      402
    );
  }
  if (entry.requestBindingHash !== opts.requestBindingHash) {
    return c.json(
      {
        error: "Bound payment request binding mismatch for recovery attempt",
        code: X402_ERROR_CODES.INVALID_PAYLOAD,
        retryable: false,
        nextSteps: "start_new_payment",
        paymentId: entry.relayPaymentId,
        requestCorrelationId: opts.requestCorrelationId,
        asset: opts.asset,
        network: opts.network,
        resource: c.req.path,
      },
      400
    );
  }
  return null;
}

function matchesBoundPaymentId(
  boundRelayPaymentId: string | undefined,
  boundCallerPaymentId: string | undefined,
  suppliedId: string
): boolean {
  return (
    (Boolean(boundRelayPaymentId) && suppliedId === boundRelayPaymentId) ||
    (Boolean(boundCallerPaymentId) && suppliedId === boundCallerPaymentId)
  );
}

/**
 * Derive a deterministic request correlation key (`pay_<28 hex chars>`)
 * from the signed transaction and payment requirements for internal lookup.
 * Kept strictly separate from the per-attempt settlement identifier,
 * the relay-assigned `paymentId`, and the confirmed `txid`.
 */
export async function deriveRequestCorrelationId(
  cleanTxHex: string,
  expectedRecipient: string,
  minAmount: string,
  asset: string
): Promise<string> {
  const hashHex = await sha256Hex(
    `${cleanTxHex.toLowerCase()}|${expectedRecipient}|${minAmount}|${asset}`
  );
  return `pay_${hashHex.slice(0, 28)}`;
}

/**
 * Deserialize a Stacks transaction hex and extract its verified origin signer,
 * authType (Standard vs Sponsored), and nonce.
 * Never trusts unsigned outer payload fields.
 */
export function extractVerifiedTransactionOrigin(
  txHex: string,
  network: "mainnet" | "testnet"
): VerifiedTransactionOrigin | null {
  try {
    const cleanHex = stripHexPrefix(txHex.trim());
    if (!cleanHex || cleanHex.length < 20) {
      return null;
    }
    const tx = deserializeTransaction(cleanHex);
    const sc = tx.auth?.spendingCondition as
      | { hashMode?: number; signer?: string; nonce?: bigint | number }
      | undefined;
    if (!sc || typeof sc.signer !== "string" || sc.signer.length === 0 || sc.hashMode === undefined) {
      return null;
    }
    const version = addressHashModeToVersion(sc.hashMode, network);
    const payerAddress = Address.stringify({ hash160: sc.signer, version });
    if (!payerAddress) {
      return null;
    }
    return {
      cleanHex,
      payerAddress,
      authType: tx.auth.authType,
      nonce: String(sc.nonce ?? 0),
    };
  } catch {
    return null;
  }
}

const PAYER_NONCE_GUARD_TIMEOUT_MS = 2_500;

function stringifyWithBigInt(value: unknown): string {
  return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
}

export type ExecutedTxOriginMatch = boolean | "unknown";

/**
 * Verify that an executed on-chain transaction matches the caller's submitted
 * signed origin (`spendingCondition` signer + nonce + signature, `payload`, and
 * `postConditions`), invariant across sponsor fee/nonce co-signing.
 * Returns `"unknown"` when either hex cannot be deserialized so a truncated or
 * future-version `raw_tx` is never misclassified as proof of nonce replacement.
 */
export function doesExecutedTxMatchSubmittedOrigin(
  submittedCleanHex: string,
  executedRawHex: string
): ExecutedTxOriginMatch {
  try {
    const subHex = stripHexPrefix(submittedCleanHex.trim());
    const execHex = stripHexPrefix(executedRawHex.trim());
    if (!subHex || !execHex) {
      return "unknown";
    }
    const subTx = deserializeTransaction(subHex);
    const execTx = deserializeTransaction(execHex);
    return (
      stringifyWithBigInt(subTx.auth?.spendingCondition) ===
        stringifyWithBigInt(execTx.auth?.spendingCondition) &&
      serializePayload(subTx.payload) === serializePayload(execTx.payload) &&
      subTx.postConditionMode === execTx.postConditionMode &&
      stringifyWithBigInt(subTx.postConditions) ===
        stringifyWithBigInt(execTx.postConditions)
    );
  } catch {
    return "unknown";
  }
}

export const defaultCheckPayerNonceBeforeNewPayment: CheckPayerNonceBeforeNewPaymentFn =
  async ({ payerAddress, txNonce, cleanTxHex, network, hiroApiKey, log }) => {
    const hiro = new HiroClient(log, network, hiroApiKey);
    let nonceConsumed = false;
    try {
      const nonces = await hiro.getAccountNonces(
        payerAddress,
        AbortSignal.timeout(PAYER_NONCE_GUARD_TIMEOUT_MS)
      );
      const nonceState = classifySenderNonceState(txNonce, nonces);
      if (nonceState === "unused") {
        return { outcome: "unused" };
      }
      if (nonceState === "pending") {
        return {
          outcome: "pending",
          reason: isMissingSenderNonceGap(txNonce, nonces)
            ? "missing_nonce_gap"
            : "mempool",
        };
      }

      nonceConsumed = true;
      let matchedTx: Awaited<ReturnType<HiroClient["getTransactionBySenderNonce"]>> = null;
      try {
        matchedTx = await hiro.getTransactionBySenderNonce(
          payerAddress,
          txNonce,
          AbortSignal.timeout(PAYER_NONCE_GUARD_TIMEOUT_MS)
        );
      } catch (byNonceErr) {
        log.warn(
          "Indexed (from_address, nonce) lookup failed; falling back to recent 50 transactions scan",
          {
            payerAddress,
            txNonce,
            error: String(byNonceErr),
          }
        );
      }
      if (!matchedTx) {
        const recentTxs = await hiro.getAddressTransactions(
          payerAddress,
          50,
          AbortSignal.timeout(PAYER_NONCE_GUARD_TIMEOUT_MS)
        );
        matchedTx =
          recentTxs.find(
            (t) =>
              t.sender_address === payerAddress &&
              Number(t.nonce) === txNonce &&
              t.canonical !== false
          ) ?? null;
      }
      if (!matchedTx || typeof matchedTx.tx_id !== "string" || matchedTx.tx_id.length === 0) {
        return { outcome: "unavailable", reason: "consumed_tx_unindexed" };
      }
      const rawHex = await hiro.getRawTransactionHex(
        matchedTx.tx_id,
        AbortSignal.timeout(PAYER_NONCE_GUARD_TIMEOUT_MS)
      );
      const originMatch = doesExecutedTxMatchSubmittedOrigin(cleanTxHex, rawHex);
      if (originMatch === "unknown") {
        return { outcome: "unavailable", reason: "consumed_tx_unparseable" };
      }
      if (originMatch === false) {
        return { outcome: "replaced" };
      }
      if (matchedTx.tx_status === "success") {
        const normalizedTxid = matchedTx.tx_id.startsWith("0x")
          ? matchedTx.tx_id
          : `0x${matchedTx.tx_id}`;
        return { outcome: "confirmed", txid: normalizedTxid };
      }
      return { outcome: "aborted" };
    } catch (err) {
      log.warn(
        "Failed to verify payer account nonce before start_new_payment; keeping retry_later",
        {
          payerAddress,
          txNonce,
          error: String(err),
        }
      );
      return {
        outcome: "unavailable",
        reason: nonceConsumed ? "consumed_tx_unparseable" : "nonce_state_unknown",
      };
    }
  };

function extractCallerSuppliedPaymentId(
  paymentPayload: PaymentPayloadV2,
  headerPaymentId?: string
): string | undefined {
  if (headerPaymentId && headerPaymentId.startsWith("pay_")) {
    return headerPaymentId;
  }
  const ext = paymentPayload.extensions as Record<string, unknown> | undefined;
  const paymentIdentifier = ext?.["payment-identifier"] as
    | { info?: { id?: unknown } }
    | undefined;
  const extId = paymentIdentifier?.info?.id;
  if (typeof extId === "string" && extId.startsWith("pay_")) {
    return extId;
  }
  return undefined;
}

/**
 * Convert token type and contract to v2 asset string
 */
function getAssetV2(
  tokenType: TokenType,
  network: "mainnet" | "testnet"
): string {
  if (tokenType === "STX") {
    return "STX";
  }
  const contract = TOKEN_CONTRACTS[network][tokenType];
  return `${contract.address}.${contract.name}`;
}

/**
 * Extract checkStatusUrl from top-level settleResult, settleResult.extensions,
 * or construct from relay URL + canonical relay paymentId.
 */
export function extractCheckStatusUrl(
  settleResult: Partial<SettleResult> & Record<string, unknown>,
  relayBaseUrl: string,
  paymentId: string
): string {
  if (typeof settleResult.checkStatusUrl === "string" && settleResult.checkStatusUrl.length > 0) {
    return settleResult.checkStatusUrl;
  }
  const ext = settleResult.extensions as Record<string, unknown> | undefined;
  if (ext && typeof ext.checkStatusUrl === "string" && ext.checkStatusUrl.length > 0) {
    return ext.checkStatusUrl;
  }
  const base = relayBaseUrl.replace(/\/$/, "");
  return `${base}/payment/${paymentId}`;
}

function trackPaymentInDO(
  c: { env: Env },
  input: {
    paymentId: string;
    checkStatusUrl: string;
    payerAddress: string;
    route: string;
    tokenType: string;
  },
  log: Logger
): void {
  if (!c.env.PAYMENT_POLLING_DO) {
    return;
  }
  try {
    const doId = c.env.PAYMENT_POLLING_DO.idFromName(input.paymentId);
    c.env.PAYMENT_POLLING_DO.get(doId)
      .track(input)
      .catch((err: unknown) => {
        log.warn("PaymentPollingDO.track failed (non-blocking)", {
          paymentId: input.paymentId,
          err: String(err),
        });
      });
  } catch (err) {
    log.warn("PaymentPollingDO.track invocation failed (non-blocking)", {
      paymentId: input.paymentId,
      err: String(err),
    });
  }
}

interface TxGuardDOStub {
  getTxGuard?: () => Promise<TxGuardRecord | null>;
  claimTx?: (input: ClaimTxInput) => Promise<ClaimTxResult>;
  releaseTxClaim?: (claimId: string) => Promise<void>;
  bindTxPayment?: (input: BindTxPaymentInput) => Promise<TxGuardRecord>;
  recordNonceGuardUnavailable?: (txHash: string) => Promise<number>;
  recordNonceGuardMissingGap?: (txHash: string) => Promise<number>;
  resetNonceGuardCounters?: (txHash: string) => Promise<void>;
  clearBoundTx?: (
    expectedRelayPaymentId: string,
    reason?: ClearBoundTxReason,
    expectedBindingId?: string
  ) => Promise<ClearBoundTxResult | boolean | void>;
  markTxConsumed?: (input: MarkTxConsumedInput) => Promise<{
    alreadyConsumed: boolean;
    record: TxGuardRecord;
  }>;
}

type DoGuardLookupResult =
  | { available: false }
  | { available: true; record: TxGuardRecord | null }
  | { available: true; error: unknown };

function getTxGuardStub(c: { env: Env }, txHash: string): TxGuardDOStub | null {
  if (!c.env.PAYMENT_POLLING_DO || !txHash) {
    return null;
  }
  const doId = c.env.PAYMENT_POLLING_DO.idFromName(`tx:${txHash}`);
  return c.env.PAYMENT_POLLING_DO.get(doId) as unknown as TxGuardDOStub;
}

async function readTxGuardFromDO(
  c: { env: Env },
  txHash: string,
  log: Logger
): Promise<DoGuardLookupResult> {
  try {
    const stub = getTxGuardStub(c, txHash);
    if (!stub || typeof stub.getTxGuard !== "function") {
      return { available: false };
    }
    const record = await stub.getTxGuard();
    return { available: true, record };
  } catch (err) {
    log.error("PaymentPollingDO.getTxGuard failed", {
      txHash,
      err: String(err),
    });
    return { available: true, error: err };
  }
}

type DoClaimTxResult =
  | { available: false }
  | { available: true; result: ClaimTxResult }
  | { available: true; error: unknown };

async function claimTxInDO(
  c: { env: Env },
  input: ClaimTxInput,
  log: Logger
): Promise<DoClaimTxResult> {
  try {
    const stub = getTxGuardStub(c, input.txHash);
    if (!stub || typeof stub.claimTx !== "function") {
      return { available: false };
    }
    const result = await stub.claimTx(input);
    return { available: true, result };
  } catch (err) {
    log.error("PaymentPollingDO.claimTx failed", {
      txHash: input.txHash,
      claimId: input.claimId,
      err: String(err),
    });
    return { available: true, error: err };
  }
}

async function releaseTxClaimInDO(
  c: { env: Env },
  txHash: string,
  claimId: string,
  log: Logger
): Promise<void> {
  try {
    const stub = getTxGuardStub(c, txHash);
    if (!stub || typeof stub.releaseTxClaim !== "function") {
      return;
    }
    await stub.releaseTxClaim(claimId);
  } catch (err) {
    log.warn("PaymentPollingDO.releaseTxClaim failed (non-blocking)", {
      txHash,
      claimId,
      err: String(err),
    });
  }
}

async function bindTxPaymentInDO(
  c: { env: Env },
  input: BindTxPaymentInput,
  log: Logger
): Promise<{ available: boolean; record?: TxGuardRecord; error?: unknown }> {
  try {
    const stub = getTxGuardStub(c, input.txHash);
    if (!stub || typeof stub.bindTxPayment !== "function") {
      return { available: false };
    }
    const record = await stub.bindTxPayment(input);
    return { available: true, record };
  } catch (err) {
    log.error("PaymentPollingDO.bindTxPayment failed", {
      txHash: input.txHash,
      paymentId: input.relayPaymentId,
      err: String(err),
    });
    return { available: true, error: err };
  }
}

async function clearBoundTxInDO(
  c: { env: Env },
  txHash: string,
  expectedRelayPaymentId: string,
  reason: ClearBoundTxReason,
  log: Logger,
  expectedBindingId?: string
): Promise<{ available: boolean; result?: ClearBoundTxResult; error?: unknown }> {
  try {
    const stub = getTxGuardStub(c, txHash);
    if (!stub || typeof stub.clearBoundTx !== "function") {
      return { available: false };
    }
    const rawResult =
      expectedBindingId !== undefined
        ? await stub.clearBoundTx(expectedRelayPaymentId, reason, expectedBindingId)
        : await stub.clearBoundTx(expectedRelayPaymentId, reason);
    if (
      typeof rawResult === "object" &&
      rawResult !== null &&
      "failedAttempts" in rawResult
    ) {
      return { available: true, result: rawResult as ClearBoundTxResult };
    }
    return { available: true };
  } catch (err) {
    log.error("PaymentPollingDO.clearBoundTx failed", {
      txHash,
      expectedRelayPaymentId,
      reason,
      err: String(err),
    });
    return { available: true, error: err };
  }
}

async function recordNonceGuardUnavailableInDO(
  c: { env: Env },
  txHash: string,
  log: Logger
): Promise<number> {
  try {
    const stub = getTxGuardStub(c, txHash);
    if (stub && typeof stub.recordNonceGuardUnavailable === "function") {
      const count = await stub.recordNonceGuardUnavailable(txHash);
      if (typeof count === "number" && count > 0) {
        setFailedAttemptCount(txHash, getFailedAttemptCount(txHash), undefined, count, 0);
        return count;
      }
    }
  } catch (err) {
    log.warn("PaymentPollingDO.recordNonceGuardUnavailable failed; using isolate counter", {
      txHash,
      err: String(err),
    });
  }
  return recordIsolateNonceGuardUnavailable(txHash);
}

async function recordNonceGuardMissingGapInDO(
  c: { env: Env },
  txHash: string,
  log: Logger
): Promise<number> {
  try {
    const stub = getTxGuardStub(c, txHash);
    if (stub && typeof stub.recordNonceGuardMissingGap === "function") {
      const count = await stub.recordNonceGuardMissingGap(txHash);
      if (typeof count === "number" && count > 0) {
        setFailedAttemptCount(txHash, getFailedAttemptCount(txHash), undefined, 0, count);
        return count;
      }
    }
  } catch (err) {
    log.warn("PaymentPollingDO.recordNonceGuardMissingGap failed; using isolate counter", {
      txHash,
      err: String(err),
    });
  }
  return recordIsolateNonceGuardGap(txHash);
}

async function resetNonceGuardCountersInDO(
  c: { env: Env },
  txHash: string,
  log: Logger
): Promise<void> {
  resetIsolateNonceGuardCounters(txHash);
  try {
    const stub = getTxGuardStub(c, txHash);
    if (stub && typeof stub.resetNonceGuardCounters === "function") {
      await stub.resetNonceGuardCounters(txHash);
    }
  } catch (err) {
    log.warn("PaymentPollingDO.resetNonceGuardCounters failed (non-blocking)", {
      txHash,
      err: String(err),
    });
  }
}

async function markTxConsumedInDO(
  c: { env: Env },
  input: MarkTxConsumedInput,
  log: Logger
): Promise<{ available: boolean; alreadyConsumed?: boolean; error?: unknown }> {
  try {
    const stub = getTxGuardStub(c, input.txHash);
    if (!stub || typeof stub.markTxConsumed !== "function") {
      return { available: false };
    }
    const res = await stub.markTxConsumed(input);
    return { available: true, alreadyConsumed: res.alreadyConsumed };
  } catch (err) {
    log.error("PaymentPollingDO.markTxConsumed failed", {
      txHash: input.txHash,
      paymentId: input.relayPaymentId,
      err: String(err),
    });
    return { available: true, error: err };
  }
}

function respondPaymentStoreUnavailable(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
): Response {
  c.header("Retry-After", "5");
  return c.json(
    {
      error: "Payment state store temporarily unavailable, please retry",
      code: X402_ERROR_CODES.UNEXPECTED_SETTLE_ERROR,
      retryable: true,
      retryAfter: 5,
      nextSteps: "retry_later",
    },
    503
  );
}

/**
 * Classify payment errors for appropriate response
 */
export function classifyPaymentError(error: unknown, settleResult?: Partial<SettleResult>): {
  code: string;
  message: string;
  httpStatus: number;
  retryAfter?: number;
} {
  // Canonical status check — use tx-schemas status field when present (boring-tx relay).
  const rawCanonicalStatus = settleResult && "status" in settleResult
    ? (settleResult as { status?: string }).status
    : undefined;
  const canonicalStatus = normalizeOptionalPublicPaymentStatus(rawCanonicalStatus);

  if (
    canonicalStatus === "queued" ||
    canonicalStatus === "broadcasting" ||
    canonicalStatus === "mempool"
  ) {
    return {
      code: X402_ERROR_CODES.TRANSACTION_PENDING,
      message: "Transaction pending in settlement relay, please retry",
      httpStatus: 402,
      retryAfter: 10,
    };
  }
  const rawErrorCode = settleResult
    ? ((settleResult as { errorCode?: string; errorReason?: string }).errorCode ??
        (settleResult as { errorReason?: string }).errorReason)
    : undefined;
  const normalizedCode = rawErrorCode?.toUpperCase();
  if (normalizedCode === "INSUFFICIENT_FUNDS") {
    return {
      code: X402_ERROR_CODES.INSUFFICIENT_FUNDS,
      message: "Insufficient funds in wallet",
      httpStatus: 402,
    };
  }
  if (canonicalStatus === "failed") {
    return { code: X402_ERROR_CODES.TRANSACTION_FAILED, message: "Payment failed in settlement relay", httpStatus: 402 };
  }
  if (canonicalStatus === "replaced") {
    return { code: X402_ERROR_CODES.TRANSACTION_FAILED, message: "Payment was replaced, start a new payment flow", httpStatus: 402 };
  }
  if (canonicalStatus === "not_found") {
    return { code: X402_ERROR_CODES.INVALID_TRANSACTION_STATE, message: "Payment identity expired or was not found, start a new payment flow", httpStatus: 402 };
  }

  // Transient pre-enqueue relay or settlement rejections (status omitted, e.g. QUEUE_UNAVAILABLE / BROADCAST_RATE_LIMITED)
  const settleTerminalReason = settleResult && "terminalReason" in settleResult
    ? (settleResult as { terminalReason?: TerminalReason }).terminalReason
    : undefined;
  const settleRetryable = settleResult && "retryable" in settleResult
    ? (settleResult as { retryable?: boolean }).retryable
    : undefined;
  if (
    settleTerminalReason &&
    settleRetryable !== false &&
    isRelayRetryableTerminalReason(settleTerminalReason)
  ) {
    return {
      code: X402_ERROR_CODES.UNEXPECTED_SETTLE_ERROR,
      message: "Settlement relay temporarily unavailable, please retry",
      httpStatus: 503,
      retryAfter: 30,
    };
  }

  // Legacy string-heuristic fallback — used when relay does not return canonical status.
  const errorStr = String(error).toLowerCase();
  const errorReason = settleResult && "errorReason" in settleResult
    ? (settleResult as { errorReason?: string }).errorReason
    : undefined;
  const resultError = errorReason?.toLowerCase() || "";
  const combined = `${errorStr} ${resultError}`;

  if (combined.includes("fetch") || combined.includes("network") || combined.includes("timeout")) {
    return { code: X402_ERROR_CODES.UNEXPECTED_SETTLE_ERROR, message: "Network error with settlement relay", httpStatus: 502, retryAfter: 5 };
  }

  if (combined.includes("503") || combined.includes("unavailable")) {
    return { code: X402_ERROR_CODES.UNEXPECTED_SETTLE_ERROR, message: "Settlement relay temporarily unavailable", httpStatus: 503, retryAfter: 30 };
  }

  if (combined.includes("insufficient") || combined.includes("balance")) {
    return { code: X402_ERROR_CODES.INSUFFICIENT_FUNDS, message: "Insufficient funds in wallet", httpStatus: 402 };
  }

  if (combined.includes("broadcast_failed") || combined.includes("broadcast failed")) {
    return { code: X402_ERROR_CODES.BROADCAST_FAILED, message: "Settlement relay broadcast failed, please retry", httpStatus: 502, retryAfter: 5 };
  }

  if (combined.includes("transaction_failed") || combined.includes("transaction failed")) {
    return { code: X402_ERROR_CODES.TRANSACTION_FAILED, message: "Transaction failed in settlement relay", httpStatus: 402 };
  }

  if (combined.includes("transaction_pending") || combined.includes("transaction pending")) {
    return { code: X402_ERROR_CODES.TRANSACTION_PENDING, message: "Transaction pending in settlement relay, please retry", httpStatus: 402, retryAfter: 10 };
  }

  if (combined.includes("amount") && (combined.includes("low") || combined.includes("minimum"))) {
    return { code: X402_ERROR_CODES.AMOUNT_INSUFFICIENT, message: "Payment amount below minimum required", httpStatus: 402 };
  }

  if (combined.includes("expired") || combined.includes("nonce")) {
    return { code: X402_ERROR_CODES.INVALID_TRANSACTION_STATE, message: "Payment expired, please sign a new payment", httpStatus: 402 };
  }

  if (combined.includes("sender_mismatch") || combined.includes("sender mismatch")) {
    return { code: X402_ERROR_CODES.SENDER_MISMATCH, message: "Payment sender does not match expected address", httpStatus: 400 };
  }

  if (combined.includes("unsupported_scheme") || combined.includes("unsupported scheme")) {
    return { code: X402_ERROR_CODES.UNSUPPORTED_SCHEME, message: "Unsupported payment scheme", httpStatus: 400 };
  }

  if (combined.includes("invalid") || combined.includes("signature")) {
    return { code: X402_ERROR_CODES.INVALID_PAYLOAD, message: "Invalid payment signature", httpStatus: 400 };
  }

  if (combined.includes("recipient")) {
    return { code: X402_ERROR_CODES.RECIPIENT_MISMATCH, message: "Payment recipient mismatch", httpStatus: 400 };
  }

  return { code: X402_ERROR_CODES.UNEXPECTED_SETTLE_ERROR, message: "Payment processing error", httpStatus: 500, retryAfter: 5 };
}

/**
 * Derive DerivedHints for exception-path errors (no canonical status from relay).
 * Maps classified error code → hints using the same stable token vocabulary.
 */
function hintsFromClassifiedCode(classified: { code: string; retryAfter?: number }): DerivedHints {
  switch (classified.code) {
    case X402_ERROR_CODES.TRANSACTION_PENDING:
      return { retryable: true, retryAfter: classified.retryAfter ?? 10, nextSteps: "retry_later" };
    case X402_ERROR_CODES.BROADCAST_FAILED:
    case X402_ERROR_CODES.UNEXPECTED_SETTLE_ERROR:
      return { retryable: true, retryAfter: classified.retryAfter ?? 5, nextSteps: "retry_later" };
    case X402_ERROR_CODES.TRANSACTION_FAILED:
      return { retryable: false, nextSteps: "start_new_payment" };
    case X402_ERROR_CODES.INVALID_TRANSACTION_STATE:
      return { retryable: true, nextSteps: "rebuild_and_resign" };
    default:
      return { retryable: false, nextSteps: "start_new_payment" };
  }
}

function getRetryAction(code: string): string {
  switch (code) {
    case X402_ERROR_CODES.TRANSACTION_PENDING:
      return "reuse_same_payment";
    case X402_ERROR_CODES.INVALID_TRANSACTION_STATE:
      return "rebuild_and_resign";
    case X402_ERROR_CODES.BROADCAST_FAILED:
    case X402_ERROR_CODES.UNEXPECTED_SETTLE_ERROR:
      return "retry_later";
    case X402_ERROR_CODES.TRANSACTION_FAILED:
      return "start_new_payment";
    default:
      return "do_not_retry";
  }
}

// =============================================================================
// Middleware Factory
// =============================================================================

/**
 * Create x402 v2 payment middleware
 *
 * @param options - Configuration for the middleware
 * @returns Hono middleware handler
 */
export function x402Middleware(
  options: X402MiddlewareOptions = {}
): MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> {
  const {
    tier = "standard",
    dynamic = false,
    estimator,
    rpcPollMaxAttempts = 15,
    rpcPollIntervalMs = 1000,
    checkPayerNonceBeforeNewPayment = defaultCheckPayerNonceBeforeNewPayment,
  } = options;

  return async (c, next) => {
    const log = c.var.logger;

    // Check if x402 is configured. Skip is allowed only in local development —
    // staging/production deploys must have X402_SERVER_ADDRESS or all paid routes
    // silently become free.
    if (!c.env.X402_SERVER_ADDRESS) {
      if (c.env.ENVIRONMENT === "development") {
        log.warn("X402_SERVER_ADDRESS not configured (local dev), skipping payment verification");
        return next();
      }
      log.error("X402_SERVER_ADDRESS not configured outside local dev — refusing request", {
        environment: c.env.ENVIRONMENT,
      });
      return c.json(
        { error: "x402 misconfiguration", code: "NOT_CONFIGURED" },
        503
      );
    }

    // Get token type from header or query
    const tokenTypeStr = c.req.header("X-PAYMENT-TOKEN-TYPE") || c.req.query("tokenType") || "STX";
    let tokenType: TokenType;
    try {
      tokenType = validateTokenType(tokenTypeStr);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    // Calculate price estimate based on pricing type
    let priceEstimate: PriceEstimate;
    let parsedBody: unknown = undefined;

    if (dynamic) {
      try {
        parsedBody = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON in request body" }, 400);
      }

      if (estimator) {
        priceEstimate = estimator(parsedBody, tokenType, log);
      } else {
        const chatRequest = parsedBody as ChatCompletionRequest;

        if (typeof chatRequest.model !== "string" || chatRequest.model.length === 0) {
          return c.json({ error: "Missing or invalid 'model' field", code: "invalid_request" }, 400);
        }

        if (!Array.isArray(chatRequest.messages) || chatRequest.messages.length === 0) {
          return c.json({ error: "Missing or invalid 'messages' field: must be a non-empty array", code: "invalid_request" }, 400);
        }

        if (c.env.OPENROUTER_API_KEY) {
          const modelResult = await lookupModel(chatRequest.model, c.env.OPENROUTER_API_KEY, log);
          if (modelResult.valid && modelResult.degraded) {
            log.warn("Model cache degraded at middleware — skipping pre-payment model validation", {
              model: chatRequest.model,
            });
            logPaymentEvent(log, "warn", "payment.fallback_used", {
              route: c.req.path,
              status: "requires_payment",
              action: "fallback_pricing_estimate",
            }, {
              instability: "fee_estimation_issue",
              model: chatRequest.model,
              fallback_source: "model_cache_degraded",
            });
          } else if (!modelResult.valid) {
            return c.json(
              { error: modelResult.error, code: "invalid_model", model: chatRequest.model },
              400
            );
          }
          priceEstimate = estimateChatPayment(chatRequest, tokenType, log, modelResult.pricing);
        } else {
          priceEstimate = estimateChatPayment(chatRequest, tokenType, log);
        }
      }
    } else {
      priceEstimate = getFixedTierEstimate(tier, tokenType);
    }

    // Skip payment for free tier
    if (tier === "free" && !dynamic) {
      c.set("x402", {
        payerAddress: "anonymous",
        settleResult: { success: true, transaction: "", network: networkToCAIP2(c.env.X402_NETWORK), payer: "anonymous" },
        paymentPayload: undefined,
        paymentRequirements: undefined,
        priceEstimate,
        parsedBody,
      } as X402Context);
      return next();
    }

    const networkV2 = networkToCAIP2(c.env.X402_NETWORK);
    const asset = getAssetV2(tokenType, c.env.X402_NETWORK);

    // Build payment requirements for v2
    const paymentRequirements: PaymentRequirementsV2 = {
      scheme: "exact",
      network: networkV2,
      amount: priceEstimate.amountInToken.toString(),
      asset,
      payTo: c.env.X402_SERVER_ADDRESS,
      maxTimeoutSeconds: 300,
      extra: {
        pricing: dynamic
          ? {
              type: "dynamic",
              estimate: {
                model: priceEstimate.model,
                estimatedInputTokens: priceEstimate.estimatedInputTokens,
                estimatedOutputTokens: priceEstimate.estimatedOutputTokens,
                estimatedCostUsd: priceEstimate.costWithMarginUsd.toFixed(6),
              },
            }
          : {
              type: "fixed",
              tier,
            },
      },
    };

    // Check for v2 payment header
    const paymentSignature = c.req.header(X402_HEADERS.PAYMENT_SIGNATURE);

    if (!paymentSignature) {
      log.info("No payment header, returning 402", {
        tier: dynamic ? "dynamic" : tier,
        amountRequired: paymentRequirements.amount,
        asset,
        network: networkV2,
      });
      logPaymentEvent(log, "info", "payment.required", {
        route: c.req.path,
        status: "requires_payment",
        action: "return_402",
      }, {
        tier: dynamic ? "dynamic" : tier,
        amountRequired: paymentRequirements.amount,
        asset,
        network: networkV2,
      });

      const paymentRequired: PaymentRequiredV2 = {
        x402Version: 2,
        resource: {
          url: c.req.path,
          description: `x402 API - ${c.req.path}`,
          mimeType: "application/json",
        },
        accepts: [paymentRequirements],
      };

      const endpointMetadata = getEndpointMetadata(c.req.path, c.req.method);
      if (endpointMetadata) {
        paymentRequired.extensions = {
          bazaar: buildBazaarExtension(endpointMetadata).bazaar,
        };
        log.debug("Added Bazaar extension to 402 response", { path: c.req.path });
      }

      c.header(X402_HEADERS.PAYMENT_REQUIRED, encodeBase64Json(paymentRequired));

      return c.json(paymentRequired, 402);
    }

    // Parse v2 payment payload from base64
    const paymentPayload = decodeBase64Json<PaymentPayloadV2>(paymentSignature);

    if (!paymentPayload || paymentPayload.x402Version !== 2 || !paymentPayload.payload) {
      log.error("Invalid payment payload", { paymentSignature: paymentSignature.substring(0, 50) });
      return c.json({
        error: "Invalid payment-signature header",
        code: X402_ERROR_CODES.INVALID_PAYLOAD,
      }, 400);
    }

    const rawTxHex =
      paymentPayload.payload.transaction ??
      ((paymentPayload.payload as unknown as Record<string, unknown>).signedTransaction as string | undefined);

    if (!rawTxHex || typeof rawTxHex !== "string") {
      return c.json({
        error: "Missing transaction hex in paymentPayload.payload",
        code: X402_ERROR_CODES.INVALID_PAYLOAD,
      }, 400);
    }

    const txOrigin = extractVerifiedTransactionOrigin(rawTxHex, c.env.X402_NETWORK);
    const cleanTxHex = txOrigin?.cleanHex ?? stripHexPrefix(rawTxHex.trim());
    const callerSuppliedPaymentId = extractCallerSuppliedPaymentId(
      paymentPayload,
      c.req.header("X-PAYMENT-ID")
    );

    // Derive deterministic correlation & idempotency ID so timed-out/retried requests
    // hit the relay's idempotency cache and avoid SENDER_NONCE_DUPLICATE.
    // Cross-isolate replay of confirmed payments is blocked durably by PaymentPollingDO.markTxConsumed.
    const requestCorrelationId = await deriveRequestCorrelationId(
      cleanTxHex,
      c.env.X402_SERVER_ADDRESS,
      paymentRequirements.amount,
      asset
    );
    const baseSettlementAttemptId = callerSuppliedPaymentId ?? requestCorrelationId;
    const txHash = await sha256Hex(cleanTxHex.toLowerCase());
    let settlementAttemptId = await resolveSettlementAttemptId(
      baseSettlementAttemptId,
      getFailedAttemptCount(txHash)
    );

    // Refuse replay of an already-confirmed and served payment immediately (keyed by txHash; cross-isolate DO is checked below)
    if (isPaymentConsumed(txHash)) {
      const knownConsumedPaymentId = CONSUMED_PAYMENTS.relayIdByTxHash.get(txHash);
      return respondConsumedPayment(c, {
        paymentId: knownConsumedPaymentId,
        requestCorrelationId,
        asset,
        network: networkV2,
      });
    }

    paymentPayload.extensions = {
      ...(paymentPayload.extensions ?? {}),
      "payment-identifier": { info: { id: settlementAttemptId } },
    };

    const verifier = new X402PaymentVerifier(c.env.X402_FACILITATOR_URL);
    const settlementTransport = c.env.X402_RELAY ? "rpc" : "http";

    log.info("Initiating x402 payment settlement", {
      settlementTransport,
      requestCorrelationId,
      settlementAttemptId,
      route: c.req.path,
      asset,
      network: networkV2,
    });
    logPaymentEvent(log, "info", "payment.initiated", {
      route: c.req.path,
      paymentId: settlementAttemptId,
      status: "requires_payment",
      action: "submit_to_relay",
    }, {
      settlementTransport,
      requestCorrelationId,
      relayUrl: c.env.X402_FACILITATOR_URL,
      asset,
      network: networkV2,
    });

    let settleResult: SettleResult = {
      success: false,
      transaction: "",
      network: networkV2,
      status: "failed",
      errorReason: "uninitialized",
    } as unknown as SettleResult;
    let canonicalPaymentId = settlementAttemptId;
    let hasRelayMintedPaymentId = false;
    let settledViaHttpVerifier = false;
    let activeHeldClaimId: string | undefined;
    let releasedBoundPaymentOnTerminalFailure = false;
    let verifiedPayer = txOrigin?.payerAddress;

    try {
      if (c.env.X402_RELAY) {
        const requestBindingHash = await computeRequestBindingHash(c, log);
        if (!requestBindingHash) {
          return c.json(
            {
              error: "Unreadable request body for payment binding",
              code: X402_ERROR_CODES.INVALID_PAYLOAD,
            },
            400
          );
        }

        // Verified transaction origin check:
        // Never trust unsigned outer `paymentPayload.payer` and never fall back to `c.env.X402_SERVER_ADDRESS`.
        if (verifiedPayer && verifiedPayer === c.env.X402_SERVER_ADDRESS) {
          return c.json(
            {
              error: "Payment sender cannot equal seller address",
              code: X402_ERROR_CODES.SENDER_MISMATCH,
            },
            400
          );
        }

        const relayStore = getRelayBoundStore(c.env.X402_RELAY);
        let boundEntry: BoundRpcPayment | undefined;

        const hydrateFromDORecord = (rec: TxGuardRecord): { entry?: BoundRpcPayment; errorResponse?: Response } => {
          if (
            callerSuppliedPaymentId &&
            rec.relayPaymentId &&
            !matchesBoundPaymentId(rec.relayPaymentId, rec.callerSuppliedPaymentId, callerSuppliedPaymentId)
          ) {
            return {
              errorResponse: c.json(
                {
                  error: "Provided X-PAYMENT-ID does not match transaction payment binding",
                  code: X402_ERROR_CODES.SENDER_MISMATCH,
                },
                400
              ),
            };
          }
          if (
            rec.relayPaymentId &&
            rec.expectedRecipient &&
            rec.minAmount &&
            rec.asset &&
            rec.network &&
            rec.requestBindingHash
          ) {
            const hydratedEntry: BoundRpcPayment = {
              relayPaymentId: rec.relayPaymentId,
              bindingId: rec.bindingId,
              callerSuppliedPaymentId: rec.callerSuppliedPaymentId,
              requestCorrelationId,
              requestBindingHash: rec.requestBindingHash,
              txHash: rec.txHash,
              verifiedPayer: rec.verifiedPayer ?? "",
              checkStatusUrl: extractCheckStatusUrl(
                {},
                c.env.X402_FACILITATOR_URL,
                rec.relayPaymentId
              ),
              expectedRecipient: rec.expectedRecipient,
              minAmount: rec.minAmount,
              asset: rec.asset,
              network: rec.network,
              createdAt: rec.boundAt ?? Date.now(),
            };
            const mismatchResponse = validateBoundPaymentForRecovery(c, hydratedEntry, {
              verifiedPayer,
              txHash,
              requireTxHashMatch: Boolean(callerSuppliedPaymentId),
              expectedRecipient: c.env.X402_SERVER_ADDRESS,
              asset,
              network: networkV2,
              minAmount: paymentRequirements.amount,
              allowDynamicBoundAmount: dynamic,
              requestBindingHash,
              requestCorrelationId,
            });
            if (mismatchResponse) {
              return { errorResponse: mismatchResponse };
            }
            return { entry: hydratedEntry };
          }
          return {};
        };

        let warmEntryFromByRelayId = false;
        if (callerSuppliedPaymentId) {
          const byIdEntry = relayStore.byRelayId.get(callerSuppliedPaymentId);
          if (byIdEntry) {
            if (byIdEntry.txHash !== txHash) {
              const mismatchResponse = validateBoundPaymentForRecovery(c, byIdEntry, {
                verifiedPayer,
                txHash,
                requireTxHashMatch: true,
                expectedRecipient: c.env.X402_SERVER_ADDRESS,
                asset,
                network: networkV2,
                minAmount: paymentRequirements.amount,
                allowDynamicBoundAmount: dynamic,
                requestBindingHash,
                requestCorrelationId,
              });
              if (mismatchResponse) {
                return mismatchResponse;
              }
            }
            boundEntry = byIdEntry;
            warmEntryFromByRelayId = true;
          }
        }

        if (!boundEntry) {
          boundEntry = relayStore.byTxHash.get(txHash);
        }

        if (boundEntry) {
          // Treat PaymentPollingDO as authoritative for warm bound entries:
          // verify not consumed, drop stale warm entry if cleared in DO, or adopt DO's re-bound relayPaymentId.
          const warmGuardLookup = await readTxGuardFromDO(c, txHash, log);
          if ("error" in warmGuardLookup) {
            return respondPaymentStoreUnavailable(c);
          }
          const doSupportsBinding = Boolean(getTxGuardStub(c, txHash)?.bindTxPayment);
          let hydratedFromDO = false;

          if (warmGuardLookup.available) {
            const doRec = warmGuardLookup.record;
            if (doRec?.consumed) {
              removeBoundPayment(c.env.X402_RELAY, boundEntry);
              markPaymentConsumed(
                txHash,
                doRec.relayPaymentId,
                doRec.consumedTxid,
                Boolean(doRec.relayPaymentId && doRec.boundAt != null)
              );
              return respondConsumedPayment(c, {
                paymentId: doRec.relayPaymentId ?? boundEntry.relayPaymentId,
                requestCorrelationId,
                asset,
                network: networkV2,
              });
            }
            if (!doRec || !doRec.relayPaymentId) {
              if (doSupportsBinding) {
                removeBoundPayment(c.env.X402_RELAY, boundEntry);
                boundEntry = undefined;
                if ((doRec?.failedAttempts ?? 0) > 0) {
                  syncFailedAttemptCount(txHash, doRec!.failedAttempts!);
                }
              }
            } else if (
              doRec.relayPaymentId !== boundEntry.relayPaymentId ||
              (doRec.bindingId && boundEntry.bindingId && doRec.bindingId !== boundEntry.bindingId)
            ) {
              removeBoundPayment(c.env.X402_RELAY, boundEntry);
              boundEntry = undefined;
              const hydrated = hydrateFromDORecord(doRec);
              if (hydrated.errorResponse) {
                return hydrated.errorResponse;
              }
              if (hydrated.entry) {
                saveBoundPayment(c.env.X402_RELAY, hydrated.entry);
                boundEntry = hydrated.entry;
                hydratedFromDO = true;
              }
            }
          }

          if (boundEntry && !hydratedFromDO) {
            if (
              !warmEntryFromByRelayId &&
              callerSuppliedPaymentId &&
              !matchesBoundPaymentId(
                boundEntry.relayPaymentId,
                boundEntry.callerSuppliedPaymentId,
                callerSuppliedPaymentId
              )
            ) {
              return c.json(
                {
                  error: "Provided X-PAYMENT-ID does not match transaction payment binding",
                  code: X402_ERROR_CODES.SENDER_MISMATCH,
                },
                400
              );
            }
            const mismatchResponse = validateBoundPaymentForRecovery(c, boundEntry, {
              verifiedPayer,
              txHash,
              requireTxHashMatch: warmEntryFromByRelayId,
              expectedRecipient: c.env.X402_SERVER_ADDRESS,
              asset,
              network: networkV2,
              minAmount: paymentRequirements.amount,
              allowDynamicBoundAmount: dynamic,
              requestBindingHash,
              requestCorrelationId,
            });
            if (mismatchResponse) {
              return mismatchResponse;
            }
          }

          if (boundEntry && dynamic && boundEntry.requestBindingHash === requestBindingHash) {
            paymentRequirements.amount = boundEntry.minAmount;
          }
        }

        let initialSubmitStatus: string | undefined;
        let skipRpcPolling = false;

        if (!boundEntry) {
          const claimId = crypto.randomUUID();
          const claimAttempt = await claimTxInDO(
            c,
            {
              txHash,
              claimId,
              callerSuppliedPaymentId,
              expectedRecipient: c.env.X402_SERVER_ADDRESS,
              minAmount: paymentRequirements.amount,
              asset,
              network: networkV2,
              verifiedPayer: verifiedPayer ?? undefined,
              requestBindingHash,
            },
            log
          );
          if ("error" in claimAttempt) {
            return respondPaymentStoreUnavailable(c);
          }

          const respondClaimInProgressOrConflict = (rec: TxGuardRecord): Response => {
            if (
              rec.expectedRecipient &&
              rec.minAmount &&
              rec.asset &&
              rec.network &&
              rec.requestBindingHash
            ) {
              const syntheticClaimEntry: BoundRpcPayment = {
                relayPaymentId: rec.relayPaymentId ?? callerSuppliedPaymentId ?? settlementAttemptId,
                callerSuppliedPaymentId: rec.callerSuppliedPaymentId,
                requestCorrelationId,
                requestBindingHash: rec.requestBindingHash,
                txHash: rec.txHash,
                verifiedPayer: rec.verifiedPayer ?? "",
                checkStatusUrl: "",
                expectedRecipient: rec.expectedRecipient,
                minAmount: rec.minAmount,
                asset: rec.asset,
                network: rec.network,
                createdAt: rec.updatedAt,
              };
              const conflictResponse = validateBoundPaymentForRecovery(c, syntheticClaimEntry, {
                verifiedPayer,
                txHash,
                requireTxHashMatch: false,
                expectedRecipient: c.env.X402_SERVER_ADDRESS,
                asset,
                network: networkV2,
                minAmount: paymentRequirements.amount,
                allowDynamicBoundAmount: dynamic,
                requestBindingHash,
                requestCorrelationId,
              });
              if (conflictResponse) {
                return conflictResponse;
              }
            }
            c.header("Retry-After", "2");
            return c.json(
              {
                error: "Payment submission already in progress, please retry",
                code: X402_ERROR_CODES.UNEXPECTED_SETTLE_ERROR,
                retryable: true,
                retryAfter: 2,
                nextSteps: "retry_later",
                requestCorrelationId,
                asset,
                network: networkV2,
                resource: c.req.path,
              },
              503
            );
          };

          let heldClaimId: string | undefined;
          if (claimAttempt.available) {
            const claimRes = claimAttempt.result;
            if (claimRes.status === "consumed") {
              markPaymentConsumed(
                txHash,
                claimRes.record.relayPaymentId,
                claimRes.record.consumedTxid,
                Boolean(claimRes.record.relayPaymentId && claimRes.record.boundAt != null)
              );
              return respondConsumedPayment(c, {
                paymentId: claimRes.record.relayPaymentId,
                requestCorrelationId,
                asset,
                network: networkV2,
              });
            }
            if (claimRes.status === "bound") {
              const hydrated = hydrateFromDORecord(claimRes.record);
              if (hydrated.errorResponse) {
                return hydrated.errorResponse;
              }
              if (hydrated.entry) {
                saveBoundPayment(c.env.X402_RELAY, hydrated.entry);
                boundEntry = hydrated.entry;
                if (dynamic && boundEntry.requestBindingHash === requestBindingHash) {
                  paymentRequirements.amount = boundEntry.minAmount;
                }
              }
            } else if (claimRes.status === "in_progress") {
              return respondClaimInProgressOrConflict(claimRes.record);
            } else {
              heldClaimId = claimId;
              activeHeldClaimId = claimId;
              if ((claimRes.record.failedAttempts ?? 0) > 0) {
                syncFailedAttemptCount(txHash, claimRes.record.failedAttempts!);
                settlementAttemptId = await resolveSettlementAttemptId(
                  baseSettlementAttemptId,
                  getFailedAttemptCount(txHash)
                );
                canonicalPaymentId = settlementAttemptId;
                paymentPayload.extensions = {
                  ...(paymentPayload.extensions ?? {}),
                  "payment-identifier": { info: { id: settlementAttemptId } },
                };
              }
            }
          } else if (c.env.PAYMENT_POLLING_DO) {
            // Fallback for partial mock DO stubs that implement getTxGuard() without claimTx()
            const fallbackGuardLookup = await readTxGuardFromDO(c, txHash, log);
            if ("error" in fallbackGuardLookup) {
              return respondPaymentStoreUnavailable(c);
            }
            if (fallbackGuardLookup.available && fallbackGuardLookup.record?.consumed) {
              markPaymentConsumed(
                txHash,
                fallbackGuardLookup.record.relayPaymentId,
                fallbackGuardLookup.record.consumedTxid,
                Boolean(
                  fallbackGuardLookup.record.relayPaymentId &&
                  fallbackGuardLookup.record.boundAt != null
                )
              );
              return respondConsumedPayment(c, {
                paymentId: fallbackGuardLookup.record.relayPaymentId,
                requestCorrelationId,
                asset,
                network: networkV2,
              });
            }
            if (fallbackGuardLookup.available && fallbackGuardLookup.record?.relayPaymentId) {
              const hydrated = hydrateFromDORecord(fallbackGuardLookup.record);
              if (hydrated.errorResponse) {
                return hydrated.errorResponse;
              }
              if (hydrated.entry) {
                saveBoundPayment(c.env.X402_RELAY, hydrated.entry);
                boundEntry = hydrated.entry;
                if (dynamic && boundEntry.requestBindingHash === requestBindingHash) {
                  paymentRequirements.amount = boundEntry.minAmount;
                }
              }
            }
          }

          if (!boundEntry) {
            let rpcResult: Awaited<ReturnType<RelayRPC["submitPayment"]>>;
            try {
              rpcResult = await c.env.X402_RELAY.submitPayment(
                rawTxHex,
                {
                  expectedRecipient: c.env.X402_SERVER_ADDRESS,
                  minAmount: paymentRequirements.amount,
                  tokenType,
                  ...(verifiedPayer ? { expectedSender: verifiedPayer } : {}),
                  resource: c.req.path,
                  method: c.req.method,
                  maxTimeoutSeconds: paymentRequirements.maxTimeoutSeconds ?? 300,
                },
                settlementAttemptId
              );
            } catch (submitErr) {
              if (heldClaimId) {
                await releaseTxClaimInDO(c, txHash, heldClaimId, log);
              }
              throw submitErr;
            }

            if (!rpcResult.accepted) {
              // Explicit compatibility case:
              // The 402 quote does not advertise a sponsor, while pinned x402-sponsor-relay
              // rejects non-sponsored (AuthType.Standard) transactions with NOT_SPONSORED.
              const quoteAdvertisesSponsor = Boolean(
                (paymentRequirements.extra as Record<string, unknown> | undefined)?.sponsor ||
                (paymentRequirements.extra as Record<string, unknown> | undefined)?.feePayer
              );
              const isNonSponsoredCompatibilityCase =
                rpcResult.code === "NOT_SPONSORED" &&
                !quoteAdvertisesSponsor &&
                txOrigin?.authType === AuthType.Standard;

              if (isNonSponsoredCompatibilityCase) {
                log.info("Non-sponsored transaction on non-sponsored quote; settling via HTTP facilitator compatibility path", {
                  requestCorrelationId,
                  settlementAttemptId,
                  payerAddress: verifiedPayer,
                });
                logPaymentEvent(log, "info", "payment.fallback_used", {
                  route: c.req.path,
                  paymentId: settlementAttemptId,
                  status: "requires_payment",
                  action: "non_sponsored_quote_http_settle",
                }, {
                  requestCorrelationId,
                  fallback_source: "not_sponsored_rpc_rejection",
                });

                let httpResult: SettleResult;
                try {
                  httpResult = (await verifier.settle(paymentPayload, {
                    paymentRequirements,
                  })) as unknown as SettleResult;
                } catch (httpErr) {
                  if (heldClaimId) {
                    await releaseTxClaimInDO(c, txHash, heldClaimId, log);
                  }
                  throw httpErr;
                }
                if (!httpResult.success && heldClaimId) {
                  await releaseTxClaimInDO(c, txHash, heldClaimId, log);
                }
                const resolvedHttpPayer =
                  httpResult.success && httpResult.payer && httpResult.payer !== c.env.X402_SERVER_ADDRESS
                    ? httpResult.payer
                    : verifiedPayer;
                settleResult = {
                  ...httpResult,
                  ...(httpResult.success && resolvedHttpPayer ? { payer: resolvedHttpPayer } : {}),
                } as SettleResult;
                const httpRelayId = (httpResult as { paymentId?: string }).paymentId;
                if (typeof httpRelayId === "string" && httpRelayId.startsWith("pay_")) {
                  canonicalPaymentId = httpRelayId;
                  hasRelayMintedPaymentId = true;
                }
                settledViaHttpVerifier = true;
                skipRpcPolling = true;
              } else {
                if (heldClaimId) {
                  await releaseTxClaimInDO(c, txHash, heldClaimId, log);
                }
                const mappedTerminalReason = mapRelayErrorCodeToTerminalReason(rpcResult.code);
                const isRetryableRelayRejection =
                  rpcResult.retryable !== false &&
                  isRelayRetryableTerminalReason(mappedTerminalReason);
                settleResult = {
                  success: false,
                  transaction: "",
                  network: networkV2,
                  errorReason: rpcResult.code ?? "settlement_failed",
                  ...(mappedTerminalReason ? { terminalReason: mappedTerminalReason } : {}),
                  ...(typeof rpcResult.retryable === "boolean" ? { retryable: rpcResult.retryable } : {}),
                  // Omit canonical "failed" status on transient pre-enqueue relay rejections
                  // so classifyPaymentError surfaces HTTP 503 + Retry-After instead of 402 TRANSACTION_FAILED.
                  ...(!isRetryableRelayRejection ? { status: "failed" } : {}),
                  error: rpcResult.error,
                } as unknown as SettleResult;
                skipRpcPolling = true;
              }
            } else {
              if (typeof rpcResult.paymentId !== "string" || !rpcResult.paymentId.startsWith("pay_")) {
                if (heldClaimId) {
                  await releaseTxClaimInDO(c, txHash, heldClaimId, log);
                }
                return c.json(
                  {
                    error: "Settlement relay accepted payment without a canonical pay_ identifier",
                    code: X402_ERROR_CODES.UNEXPECTED_SETTLE_ERROR,
                    retryable: true,
                    nextSteps: "retry_later",
                  },
                  502
                );
              }

              const relayPaymentId = rpcResult.paymentId;
              canonicalPaymentId = relayPaymentId;
              initialSubmitStatus = normalizePublicPaymentStatus(rpcResult.status);

              if (isPaymentConsumed(txHash, relayPaymentId)) {
                if (heldClaimId) {
                  await releaseTxClaimInDO(c, txHash, heldClaimId, log);
                }
                return respondConsumedPayment(c, {
                  paymentId: relayPaymentId,
                  requestCorrelationId,
                  asset,
                  network: networkV2,
                });
              }

              const rpcReturnedPayer =
                ((rpcResult as Record<string, unknown>).payer as string | undefined) ??
                ((rpcResult as Record<string, unknown>).senderAddress as string | undefined);
              if (
                !verifiedPayer &&
                typeof rpcReturnedPayer === "string" &&
                rpcReturnedPayer.length > 0 &&
                rpcReturnedPayer !== c.env.X402_SERVER_ADDRESS
              ) {
                verifiedPayer = rpcReturnedPayer;
              }

              const relayCheckStatusUrl = extractCheckStatusUrl(
                { checkStatusUrl: rpcResult.checkStatusUrl },
                c.env.X402_FACILITATOR_URL,
                relayPaymentId
              );

              const now = Date.now();
              const bindResult = await bindTxPaymentInDO(
                c,
                {
                  txHash,
                  relayPaymentId,
                  callerSuppliedPaymentId,
                  expectedRecipient: c.env.X402_SERVER_ADDRESS,
                  minAmount: paymentRequirements.amount,
                  asset,
                  network: networkV2,
                  verifiedPayer: verifiedPayer ?? undefined,
                  requestBindingHash,
                  boundAt: now,
                  claimId: heldClaimId,
                },
                log
              );
              if ("error" in bindResult) {
                if (heldClaimId) {
                  await releaseTxClaimInDO(c, txHash, heldClaimId, log);
                }
                return respondPaymentStoreUnavailable(c);
              }

              if (bindResult.available && bindResult.record) {
                if (bindResult.record.consumed) {
                  markPaymentConsumed(
                    txHash,
                    bindResult.record.relayPaymentId,
                    bindResult.record.consumedTxid,
                    Boolean(
                      bindResult.record.relayPaymentId &&
                      bindResult.record.boundAt != null
                    )
                  );
                  return respondConsumedPayment(c, {
                    paymentId: bindResult.record.relayPaymentId ?? relayPaymentId,
                    requestCorrelationId,
                    asset,
                    network: networkV2,
                  });
                }
                const rec = bindResult.record;
                if (!rec.relayPaymentId) {
                  return respondClaimInProgressOrConflict(rec);
                }
                if (rec.relayPaymentId !== relayPaymentId) {
                  const hydrated = hydrateFromDORecord(rec);
                  if (hydrated.errorResponse) {
                    return hydrated.errorResponse;
                  }
                  boundEntry = hydrated.entry;
                } else {
                  const boundFromDO: BoundRpcPayment = {
                    relayPaymentId: rec.relayPaymentId ?? relayPaymentId,
                    bindingId: rec.bindingId,
                    callerSuppliedPaymentId: rec.callerSuppliedPaymentId ?? callerSuppliedPaymentId,
                    requestCorrelationId,
                    requestBindingHash: rec.requestBindingHash ?? requestBindingHash,
                    txHash,
                    verifiedPayer: rec.verifiedPayer ?? verifiedPayer ?? "",
                    checkStatusUrl: relayCheckStatusUrl,
                    expectedRecipient: rec.expectedRecipient ?? c.env.X402_SERVER_ADDRESS,
                    minAmount: rec.minAmount ?? paymentRequirements.amount,
                    asset: rec.asset ?? asset,
                    network: rec.network ?? networkV2,
                    createdAt: rec.boundAt ?? now,
                  };
                  const conflictResponse = validateBoundPaymentForRecovery(c, boundFromDO, {
                    verifiedPayer,
                    txHash,
                    requireTxHashMatch: false,
                    expectedRecipient: c.env.X402_SERVER_ADDRESS,
                    asset,
                    network: networkV2,
                    minAmount: paymentRequirements.amount,
                    allowDynamicBoundAmount: dynamic,
                    requestBindingHash,
                    requestCorrelationId,
                  });
                  if (conflictResponse) {
                    return conflictResponse;
                  }
                  boundEntry = boundFromDO;
                }
              } else {
                boundEntry = {
                  relayPaymentId,
                  callerSuppliedPaymentId,
                  requestCorrelationId,
                  requestBindingHash,
                  txHash,
                  verifiedPayer: verifiedPayer ?? "",
                  checkStatusUrl: relayCheckStatusUrl,
                  expectedRecipient: c.env.X402_SERVER_ADDRESS,
                  minAmount: paymentRequirements.amount,
                  asset,
                  network: networkV2,
                  createdAt: now,
                };
              }

              if (boundEntry) {
                canonicalPaymentId = boundEntry.relayPaymentId;
                if (dynamic && boundEntry.requestBindingHash === requestBindingHash) {
                  paymentRequirements.amount = boundEntry.minAmount;
                }
                saveBoundPayment(c.env.X402_RELAY, boundEntry);

                // Track enqueued payment in PaymentPollingDO using canonical relayPaymentId & checkStatusUrl
                trackPaymentInDO(
                  c,
                  {
                    paymentId: boundEntry.relayPaymentId,
                    checkStatusUrl: boundEntry.checkStatusUrl,
                    payerAddress: verifiedPayer ?? "pending",
                    route: c.req.path,
                    tokenType,
                  },
                  log
                );
              }
            }
          }
        }

        if (!skipRpcPolling && boundEntry) {
          const relayPaymentId = boundEntry.relayPaymentId;
          canonicalPaymentId = relayPaymentId;
          let relayCheckStatusUrl = boundEntry.checkStatusUrl;
          let lastStatus = normalizePublicPaymentStatus(initialSubmitStatus);
          let latestCheck: RelayCheckPaymentResult | undefined;

          // Poll checkPayment using the canonical relayPaymentId (never the request correlation key).
          // Any timeout/exception after enqueue stays on the pending path with zero HTTP resubmit.
          if (typeof c.env.X402_RELAY.checkPayment === "function") {
            const maxAttempts = Math.max(1, rpcPollMaxAttempts);
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
              if (attempt > 0 && rpcPollIntervalMs > 0) {
                await new Promise<void>((resolve) => setTimeout(resolve, rpcPollIntervalMs));
              }
              try {
                const rawCheck = await c.env.X402_RELAY.checkPayment(relayPaymentId);
                if (!rawCheck || typeof rawCheck.status !== "string") {
                  break;
                }
                latestCheck = rawCheck;
                lastStatus = normalizePublicPaymentStatus(rawCheck.status);
                if (typeof rawCheck.checkStatusUrl === "string" && rawCheck.checkStatusUrl.length > 0) {
                  relayCheckStatusUrl = rawCheck.checkStatusUrl;
                  boundEntry.checkStatusUrl = relayCheckStatusUrl;
                }

                const checkReturnedPayer =
                  ((rawCheck as unknown as Record<string, unknown>).payer as string | undefined) ??
                  ((rawCheck as unknown as Record<string, unknown>).senderAddress as string | undefined);
                if (typeof checkReturnedPayer === "string" && checkReturnedPayer.length > 0) {
                  if (verifiedPayer && checkReturnedPayer !== verifiedPayer) {
                    const expectedBindingId = boundEntry.bindingId;
                    removeBoundPayment(c.env.X402_RELAY, boundEntry);
                    const clearRes = await clearBoundTxInDO(
                      c,
                      txHash,
                      relayPaymentId,
                      "payer_mismatch",
                      log,
                      expectedBindingId
                    );
                    if ("error" in clearRes) {
                      return respondPaymentStoreUnavailable(c);
                    }
                    return c.json(
                      {
                        error: "Relay payer does not match verified transaction origin",
                        code: X402_ERROR_CODES.SENDER_MISMATCH,
                      },
                      400
                    );
                  }
                  if (!verifiedPayer && checkReturnedPayer !== c.env.X402_SERVER_ADDRESS) {
                    verifiedPayer = checkReturnedPayer;
                    boundEntry.verifiedPayer = verifiedPayer;
                  }
                }

                const isGraceWindowNotFound =
                  lastStatus === "not_found" &&
                  Date.now() - boundEntry.createdAt < NOT_FOUND_ENQUEUE_GRACE_MS;

                if (
                  lastStatus === "confirmed" ||
                  (TERMINAL_FAILURE_RPC_STATUSES.has(lastStatus) && !isGraceWindowNotFound)
                ) {
                  break;
                }
              } catch (pollErr) {
                log.warn("RPC checkPayment failed or timed out after enqueue; preserving pending relay state without HTTP resubmit", {
                  relayPaymentId,
                  requestCorrelationId,
                  attempt,
                  error: String(pollErr),
                });
                break;
              }
            }
          }

          if (lastStatus === "confirmed") {
            const confirmedTxid = latestCheck?.txid;
            if (
              typeof confirmedTxid !== "string" ||
              confirmedTxid.length === 0 ||
              confirmedTxid === relayPaymentId
            ) {
              // Do not allow enqueue job ID or empty txid to pass as confirmed settlement
              lastStatus = "queued";
            } else {
              if (isPaymentConsumed(txHash, relayPaymentId, confirmedTxid)) {
                removeBoundPayment(c.env.X402_RELAY, boundEntry);
                return respondConsumedPayment(c, {
                  paymentId: relayPaymentId,
                  requestCorrelationId,
                  asset,
                  network: networkV2,
                });
              }

              const resolvedPayer = verifiedPayer || boundEntry.verifiedPayer;
              if (!resolvedPayer || resolvedPayer === c.env.X402_SERVER_ADDRESS) {
                const expectedBindingId = boundEntry.bindingId;
                removeBoundPayment(c.env.X402_RELAY, boundEntry);
                const clearRes = await clearBoundTxInDO(
                  c,
                  txHash,
                  relayPaymentId,
                  "payer_mismatch",
                  log,
                  expectedBindingId
                );
                if ("error" in clearRes) {
                  return respondPaymentStoreUnavailable(c);
                }
                return c.json(
                  {
                    error: "Could not verify transaction origin payer for confirmed payment",
                    code: X402_ERROR_CODES.SENDER_MISMATCH,
                  },
                  400
                );
              }
              verifiedPayer = resolvedPayer;
              // Delete the in-flight bound entry once confirmed so it cannot be replayed in the same isolate
              removeBoundPayment(c.env.X402_RELAY, boundEntry);
              settleResult = {
                success: true,
                transaction: confirmedTxid,
                network: networkV2,
                payer: verifiedPayer,
                paymentId: relayPaymentId,
                status: "confirmed",
                checkStatusUrl: relayCheckStatusUrl,
              } as unknown as SettleResult;
            }
          }

          const isNotFoundWithinGraceWindow =
            lastStatus === "not_found" &&
            Date.now() - boundEntry.createdAt < NOT_FOUND_ENQUEUE_GRACE_MS;

          if (TERMINAL_FAILURE_RPC_STATUSES.has(lastStatus) && !isNotFoundWithinGraceWindow) {
            const checkErrorCode = latestCheck?.errorCode;
            const checkTerminalReason =
              latestCheck?.terminalReason ??
              mapRelayErrorCodeToTerminalReason(checkErrorCode);
            const checkRetryable = latestCheck?.retryable;

            // Release dead `relayPaymentId` immediately on any terminal failure:
            // on `x402-sponsor-relay`, `failed` is final for that record (`skip_terminal_payment`)
            // and `getReusablePaymentRecord` drops terminal records, so bounded retries are
            // counted on nonce-safe resubmissions (`tx_retry_guard.failed_attempts`) under a
            // rotated `settlementAttemptId` rather than re-polling a dead `paymentId`.
            const clearRes = await clearBoundTxInDO(
              c,
              txHash,
              relayPaymentId,
              "terminal_failure",
              log,
              boundEntry.bindingId
            );
            if ("error" in clearRes) {
              return respondPaymentStoreUnavailable(c);
            }
            removeBoundPayment(c.env.X402_RELAY, boundEntry);
            if (clearRes.result?.consumed && clearRes.result.record) {
              const consumedRec = clearRes.result.record;
              markPaymentConsumed(
                txHash,
                consumedRec.relayPaymentId,
                consumedRec.consumedTxid,
                Boolean(consumedRec.relayPaymentId && consumedRec.boundAt != null)
              );
              return respondConsumedPayment(c, {
                paymentId: consumedRec.relayPaymentId ?? relayPaymentId,
                requestCorrelationId,
                asset,
                network: networkV2,
              });
            }
            if (
              clearRes.available &&
              clearRes.result &&
              !clearRes.result.cleared &&
              (clearRes.result.record?.relayPaymentId || clearRes.result.record?.claimId)
            ) {
              // Stale clear raced with a live re-bind (e.g. bindingId mismatch) or active
              // resubmission claim in DO: do NOT treat the payment as released.
              const activeRec = clearRes.result.record;
              let activePaymentId = activeRec.relayPaymentId ?? relayPaymentId;
              let activeCheckStatusUrl = activeRec.relayPaymentId
                ? extractCheckStatusUrl({}, c.env.X402_FACILITATOR_URL, activeRec.relayPaymentId)
                : undefined;
              if (activeRec.relayPaymentId) {
                const hydrated = hydrateFromDORecord(activeRec);
                if (hydrated.errorResponse) {
                  return hydrated.errorResponse;
                }
                if (hydrated.entry) {
                  saveBoundPayment(c.env.X402_RELAY, hydrated.entry);
                  activePaymentId = hydrated.entry.relayPaymentId;
                  activeCheckStatusUrl = hydrated.entry.checkStatusUrl;
                }
              }
              const retryAfterSec = activeRec.relayPaymentId ? 10 : 5;
              const livePendingHints: DerivedHints = {
                retryable: true,
                retryAfter: retryAfterSec,
                nextSteps: "retry_later",
              };
              c.header("Retry-After", String(retryAfterSec));
              if (activeRec.relayPaymentId) {
                c.header("X-PAYMENT-ID", activePaymentId);
              }
              c.header(
                X402_HEADERS.PAYMENT_RESPONSE,
                encodeBase64Json({
                  ...livePendingHints,
                  ...(activeRec.relayPaymentId ? { paymentId: activePaymentId } : {}),
                  status: "queued",
                  ...(activeCheckStatusUrl ? { checkStatusUrl: activeCheckStatusUrl } : {}),
                })
              );
              return c.json(
                {
                  error: "Transaction pending in settlement relay, please retry",
                  code: X402_ERROR_CODES.TRANSACTION_PENDING,
                  status: "queued",
                  retryable: true,
                  retryAfter: retryAfterSec,
                  nextSteps: "retry_later",
                  paymentId: activePaymentId,
                  requestCorrelationId,
                  ...(activeCheckStatusUrl ? { checkStatusUrl: activeCheckStatusUrl } : {}),
                  asset,
                  network: networkV2,
                  resource: c.req.path,
                },
                402
              );
            }
            releasedBoundPaymentOnTerminalFailure = true;
            if (clearRes.result && clearRes.result.failedAttempts > 0) {
              setFailedAttemptCount(
                txHash,
                clearRes.result.failedAttempts,
                relayPaymentId,
                clearRes.result.nonceGuardUnavailable,
                clearRes.result.nonceGuardGap
              );
            } else if ((!clearRes.available || !clearRes.result) && !boundEntry.countedTerminalRelease) {
              boundEntry.countedTerminalRelease = true;
              recordTerminalFailure(txHash, relayPaymentId);
            }

            settleResult = {
              success: false,
              transaction: latestCheck?.txid ?? "",
              network: networkV2,
              paymentId: relayPaymentId,
              status: lastStatus,
              ...(checkTerminalReason ? { terminalReason: checkTerminalReason } : {}),
              ...(checkErrorCode ? { errorCode: checkErrorCode } : {}),
              ...(typeof checkRetryable === "boolean" ? { retryable: checkRetryable } : {}),
              errorReason: checkErrorCode ?? checkTerminalReason ?? latestCheck?.error ?? lastStatus,
              checkStatusUrl: relayCheckStatusUrl,
            } as unknown as SettleResult;
          } else if (lastStatus !== "confirmed") {
            // Payment is still in-flight (queued, queued_with_warning, broadcasting, mempool, or poll timeout after enqueue).
            // Never invoke paid handler or emit payment.confirmed on enqueue!
            const pendingStatus = IN_FLIGHT_PUBLIC_STATUSES.has(lastStatus) ? lastStatus : "queued";
            const pendingHints: DerivedHints = {
              retryable: true,
              retryAfter: 10,
              nextSteps: "retry_later",
            };

            logPaymentEvent(log, "info", "payment.pending", {
              route: c.req.path,
              paymentId: relayPaymentId,
              status: "queued",
              checkStatusUrl: relayCheckStatusUrl,
              action: "reuse_same_payment",
            }, {
              requestCorrelationId,
              relayPaymentId,
              relayStatus: pendingStatus,
              payerAddress: verifiedPayer ?? null,
              classification_code: X402_ERROR_CODES.TRANSACTION_PENDING,
              http_status: 402,
              retry_after: 10,
            });

            c.header("Retry-After", "10");
            c.header("X-PAYMENT-ID", relayPaymentId);
            c.header(
              X402_HEADERS.PAYMENT_RESPONSE,
              encodeBase64Json({
                ...pendingHints,
                paymentId: relayPaymentId,
                status: pendingStatus,
                checkStatusUrl: relayCheckStatusUrl,
              })
            );

            return c.json(
              {
                error: "Transaction pending in settlement relay, please retry",
                code: X402_ERROR_CODES.TRANSACTION_PENDING,
                status: pendingStatus,
                retryable: pendingHints.retryable,
                retryAfter: pendingHints.retryAfter,
                nextSteps: pendingHints.nextSteps,
                paymentId: relayPaymentId,
                requestCorrelationId,
                checkStatusUrl: relayCheckStatusUrl,
                asset,
                network: networkV2,
                resource: c.req.path,
              },
              402
            );
          }
        }
      } else {
        // Cross-isolate DO consumption check before invoking HTTP /settle (when PAYMENT_POLLING_DO is bound)
        const httpGuardLookup = await readTxGuardFromDO(c, txHash, log);
        if ("error" in httpGuardLookup) {
          return respondPaymentStoreUnavailable(c);
        }
        if (httpGuardLookup.available && httpGuardLookup.record?.consumed) {
          markPaymentConsumed(
            txHash,
            httpGuardLookup.record.relayPaymentId,
            httpGuardLookup.record.consumedTxid,
            Boolean(httpGuardLookup.record.relayPaymentId && httpGuardLookup.record.boundAt != null)
          );
          return respondConsumedPayment(c, {
            paymentId: httpGuardLookup.record.relayPaymentId,
            requestCorrelationId,
            asset,
            network: networkV2,
          });
        }

        // HTTP facilitator path (when X402_RELAY is not bound)
        settledViaHttpVerifier = true;
        settleResult = (await verifier.settle(paymentPayload, {
          paymentRequirements,
        })) as unknown as SettleResult;
        const httpRelayId = (settleResult as { paymentId?: string }).paymentId;
        if (typeof httpRelayId === "string" && httpRelayId.startsWith("pay_")) {
          canonicalPaymentId = httpRelayId;
          hasRelayMintedPaymentId = true;
        }
      }

      log.debug("Settle result", { ...settleResult });
    } catch (error) {
      const errorStr = String(error);
      log.error("Payment settlement exception", { error: errorStr });

      const classified = classifyPaymentError(error);
      logPaymentEvent(log, "error", "payment.failed", {
        route: c.req.path,
        paymentId: canonicalPaymentId,
        status: "failed",
        action: getRetryAction(classified.code),
      }, {
        requestCorrelationId,
        classification_code: classified.code,
        http_status: classified.httpStatus,
        retry_after: classified.retryAfter ?? null,
        instability: derivePaymentInstability({
          classifiedCode: classified.code,
          error: errorStr,
        }),
        relay_failure: true,
        exceptionMessage: errorStr,
      });
      if (classified.retryAfter) {
        c.header("Retry-After", String(classified.retryAfter));
      }

      const exceptionHints = hintsFromClassifiedCode(classified);
      c.header(X402_HEADERS.PAYMENT_RESPONSE, encodeBase64Json(exceptionHints));
      c.header("X-PAYMENT-ID", canonicalPaymentId);

      return c.json(
        {
          error: classified.message,
          code: classified.code,
          retryable: exceptionHints.retryable,
          nextSteps: exceptionHints.nextSteps,
          ...(exceptionHints.retryAfter !== undefined ? { retryAfter: exceptionHints.retryAfter } : {}),
          paymentId: canonicalPaymentId,
          requestCorrelationId,
          asset,
          network: networkV2,
          resource: c.req.path,
          details: {
            exceptionMessage: errorStr,
          },
        },
        classified.httpStatus as 400 | 402 | 500 | 502 | 503
      );
    }

    if (!settleResult.success) {
      const settleRecord = settleResult as Partial<SettleResult> & Record<string, unknown>;
      const resultPaymentId =
        typeof settleRecord.paymentId === "string" && settleRecord.paymentId.startsWith("pay_")
          ? settleRecord.paymentId
          : canonicalPaymentId;
      let errorReason = (settleResult as { errorReason?: string }).errorReason;
      let canonicalStatus = normalizeOptionalPublicPaymentStatus(
        (settleResult as { status?: string }).status
      );
      let terminalReason = (settleResult as { terminalReason?: string }).terminalReason;
      const explicitRetryable = (settleResult as { retryable?: boolean }).retryable;
      let classified = classifyPaymentError(errorReason || "settlement_failed", settleResult);

      const checkStatusUrl = extractCheckStatusUrl(
        settleRecord,
        c.env.X402_FACILITATOR_URL,
        resultPaymentId
      );

      const derivedHints =
        terminalReason || canonicalStatus === "not_found" || canonicalStatus === "replaced"
          ? computeDerivedHints(canonicalStatus ?? "failed", terminalReason)
          : null;
      const baseSettleHints: DerivedHints =
        explicitRetryable === false
          ? derivedHints && !derivedHints.retryable
            ? derivedHints
            : {
                retryable: false,
                nextSteps: "start_new_payment",
              }
          : derivedHints ??
            (explicitRetryable === true
              ? {
                  retryable: true,
                  retryAfter: classified.retryAfter ?? 5,
                  nextSteps: "retry_later",
                }
              : hintsFromClassifiedCode(classified));
      const failedAttemptsAfterRelease = releasedBoundPaymentOnTerminalFailure
        ? getFailedAttemptCount(txHash)
        : 0;
      const canResendSamePayment =
        releasedBoundPaymentOnTerminalFailure &&
        baseSettleHints.nextSteps === "retry_later" &&
        canRetrySamePaymentResubmission({
          status: canonicalStatus ?? "failed",
          retryable: explicitRetryable,
          terminalReason,
          failedAttempts: failedAttemptsAfterRelease,
        });
      let settleHints: DerivedHints =
        releasedBoundPaymentOnTerminalFailure && baseSettleHints.nextSteps === "retry_later"
          ? canResendSamePayment
            ? baseSettleHints
            : {
                retryable: false,
                nextSteps: "start_new_payment",
              }
          : baseSettleHints;

      // Before emitting `start_new_payment` or `rebuild_and_resign` on a released payment (or
      // `rebuild_and_resign` on a retried tx rejected synchronously with a `sender`-category code),
      // verify the payer's account nonce via Hiro so:
      //   1. A pending sponsored tx in the mempool (e.g. `sender_nonce_duplicate` or `detected_missing_nonces`)
      //      cannot race with a freshly signed next-nonce payment (`rebuild_and_resign` / `start_new_payment`).
      //   2. A previously broadcast tx that already confirmed on-chain is settled rather than re-billed.
      // Producer contract note (`x402-sponsor-relay`): sender-conflict resolution (`queue-consumer.ts`)
      // wires matching origin txs to `"mempool"` and only marks mismatched txs `"replaced"`/`"superseded"`,
      // while sponsor RBF/`head_bump` marks `"replaced"`/`"nonce_replacement"` when evicting a sponsor slot.
      // Running the guard on released `"replaced"` as well closes any block race where the original
      // broadcast (or a re-sponsored copy of the same origin tx) still landed on-chain.
      const parsedTxNonce = txOrigin ? Number(txOrigin.nonce) : NaN;
      const shouldVerifyPayerNonce =
        Boolean(
          verifiedPayer &&
            txOrigin &&
            Number.isSafeInteger(parsedTxNonce) &&
            parsedTxNonce >= 0
        ) &&
        ((releasedBoundPaymentOnTerminalFailure &&
          (settleHints.nextSteps === "start_new_payment" ||
            settleHints.nextSteps === "rebuild_and_resign")) ||
          (!releasedBoundPaymentOnTerminalFailure &&
            settleHints.nextSteps === "rebuild_and_resign" &&
            getFailedAttemptCount(txHash) > 0));

      let guardOverrodeToRetryLater = false;
      let guardVerifyNonceDetail:
        | { payerNonce: number; unavailableReason?: PayerNonceUnavailableReason }
        | undefined;

      if (shouldVerifyPayerNonce && verifiedPayer && txOrigin) {
        const nonceVerdict = await checkPayerNonceBeforeNewPayment({
          payerAddress: verifiedPayer,
          txNonce: parsedTxNonce,
          cleanTxHex: txOrigin.cleanHex,
          network: c.env.X402_NETWORK,
          hiroApiKey: c.env.HIRO_API_KEY,
          log,
        });
        if (nonceVerdict.outcome === "confirmed") {
          await resetNonceGuardCountersInDO(c, txHash, log);
          settleResult = {
            success: true,
            transaction: nonceVerdict.txid,
            network: networkV2,
            payer: verifiedPayer,
            paymentId: resultPaymentId,
            status: "confirmed",
            checkStatusUrl,
          } as unknown as SettleResult;
        } else if (nonceVerdict.outcome === "unused") {
          await resetNonceGuardCountersInDO(c, txHash, log);
        } else if (nonceVerdict.outcome === "pending") {
          const retryAfterSec = baseSettleHints.retryAfter ?? classified.retryAfter ?? 15;
          let holdRetryLater = true;
          if (nonceVerdict.reason === "missing_nonce_gap") {
            const gapAttempts = await recordNonceGuardMissingGapInDO(c, txHash, log);
            if (gapAttempts > MAX_NONCE_GUARD_MISSING_GAP_RETRIES) {
              // Gap at a nonce the relay already failed has remained unexecuted and absent
              // from `detected_mempool_nonces` across `MAX_NONCE_GUARD_MISSING_GAP_RETRIES + 1`
              // consecutive checks: treat as unused rather than stalling indefinitely while
              // higher-nonce mempool transactions stay queued.
              holdRetryLater = false;
            }
          } else {
            await resetNonceGuardCountersInDO(c, txHash, log);
          }
          if (holdRetryLater) {
            guardOverrodeToRetryLater = true;
            canonicalStatus = "mempool";
            terminalReason = undefined;
            errorReason =
              nonceVerdict.reason === "missing_nonce_gap"
                ? "payer_nonce_missing_gap"
                : "payer_nonce_pending";
            classified = {
              code: X402_ERROR_CODES.TRANSACTION_PENDING,
              message: "Transaction pending on-chain for payer nonce, please retry",
              httpStatus: 402,
              retryAfter: retryAfterSec,
            };
            settleHints = {
              retryable: true,
              retryAfter: retryAfterSec,
              nextSteps: "retry_later",
            };
          }
        } else if (nonceVerdict.outcome === "unavailable") {
          const retryAfterSec = baseSettleHints.retryAfter ?? classified.retryAfter ?? 15;
          if (!releasedBoundPaymentOnTerminalFailure) {
            // Non-released synchronous `rebuild_and_resign` pass: convert coherently to
            // `retry_later` without consuming the released consecutive-unavailable cap.
            guardOverrodeToRetryLater = true;
            canonicalStatus = undefined;
            terminalReason = undefined;
            errorReason = "payer_nonce_guard_unavailable";
            classified = {
              code: X402_ERROR_CODES.TRANSACTION_PENDING,
              message: "Unable to verify payer account nonce, please retry",
              httpStatus: 402,
              retryAfter: retryAfterSec,
            };
            settleHints = {
              retryable: true,
              retryAfter: retryAfterSec,
              nextSteps: "retry_later",
            };
          } else {
            const unavailableAttempts = await recordNonceGuardUnavailableInDO(c, txHash, log);
            if (unavailableAttempts <= MAX_NONCE_GUARD_UNAVAILABLE_RETRIES) {
              guardOverrodeToRetryLater = true;
              canonicalStatus = undefined;
              terminalReason = undefined;
              errorReason = "payer_nonce_guard_unavailable";
              classified = {
                code: X402_ERROR_CODES.TRANSACTION_PENDING,
                message: "Unable to verify payer account nonce, please retry",
                httpStatus: 402,
                retryAfter: retryAfterSec,
              };
              settleHints = {
                retryable: true,
                retryAfter: retryAfterSec,
                nextSteps: "retry_later",
              };
            } else {
              // Never fall back to `start_new_payment` when the nonce was already consumed
              // (unindexed/unparseable anchored tx) or its state is unknown — otherwise a
              // confirmed payment whose `raw_tx` could not be read back would double-charge.
              canonicalStatus = "failed";
              terminalReason = "internal_error";
              errorReason = errorReason || "payer_nonce_verification_unavailable";
              classified = {
                code: X402_ERROR_CODES.TRANSACTION_FAILED,
                message: `Unable to verify on-chain outcome for payer nonce ${parsedTxNonce}; check payer nonce ${parsedTxNonce} on-chain before re-signing`,
                httpStatus: 402,
              };
              settleHints = {
                retryable: false,
                nextSteps: "verify_nonce_on_chain",
              };
              guardVerifyNonceDetail = {
                payerNonce: parsedTxNonce,
                unavailableReason: nonceVerdict.reason,
              };
            }
          }
        } else if (nonceVerdict.outcome === "replaced") {
          await resetNonceGuardCountersInDO(c, txHash, log);
          canonicalStatus = "replaced";
          terminalReason = "nonce_replacement";
          errorReason = "nonce_replacement";
          classified = classifyPaymentError("nonce_replacement", {
            ...settleRecord,
            status: "replaced",
            terminalReason: "nonce_replacement",
          } as unknown as SettleResult);
          settleHints = {
            retryable: false,
            nextSteps: "start_new_payment",
          };
        } else if (nonceVerdict.outcome === "aborted") {
          await resetNonceGuardCountersInDO(c, txHash, log);
          canonicalStatus = "failed";
          terminalReason = "chain_abort";
          errorReason = errorReason || "chain_abort";
          classified = classifyPaymentError(errorReason, {
            ...settleRecord,
            status: "failed",
            terminalReason: "chain_abort",
          } as unknown as SettleResult);
          settleHints = {
            retryable: false,
            nextSteps: "start_new_payment",
          };
        }
      }

      if (!settleResult.success) {
        log.error("Payment settlement failed", { ...settleResult });

        const instability = derivePaymentInstability({
          classifiedCode: classified.code,
          errorReason,
        });
        const suppressUnboundPaymentPointers =
          (releasedBoundPaymentOnTerminalFailure && settleHints.nextSteps === "retry_later") ||
          (guardOverrodeToRetryLater && !hasRelayMintedPaymentId);
        const responseCheckStatusUrl = suppressUnboundPaymentPointers
          ? undefined
          : checkStatusUrl;

        if (classified.code === X402_ERROR_CODES.TRANSACTION_PENDING) {
          logPaymentEvent(log, "info", "payment.pending", {
            route: c.req.path,
            paymentId: resultPaymentId,
            status: "queued",
            checkStatusUrl: responseCheckStatusUrl,
            action: "reuse_same_payment",
          }, {
            requestCorrelationId,
            classification_code: classified.code,
            http_status: classified.httpStatus,
            retry_after: classified.retryAfter ?? null,
            errorReason: errorReason ?? null,
            instability,
          });
        } else if (
          classified.code === X402_ERROR_CODES.TRANSACTION_FAILED &&
          (errorReason === "nonce_replacement" || errorReason === "superseded" || canonicalStatus === "replaced")
        ) {
          logPaymentEvent(log, "warn", "payment.replaced", {
            route: c.req.path,
            paymentId: resultPaymentId,
            status: "replaced",
            checkStatusUrl,
            action: "start_new_payment",
          }, {
            requestCorrelationId,
            classification_code: classified.code,
            errorReason: errorReason ?? null,
          });
        } else {
          logPaymentEvent(log, classified.httpStatus >= 500 ? "error" : "warn", "payment.failed", {
            route: c.req.path,
            paymentId: resultPaymentId,
            status: "failed",
            checkStatusUrl: responseCheckStatusUrl,
            action: releasedBoundPaymentOnTerminalFailure
              ? settleHints.nextSteps
              : getRetryAction(classified.code),
          }, {
            requestCorrelationId,
            classification_code: classified.code,
            http_status: classified.httpStatus,
            retry_after:
              settleHints.nextSteps === "retry_later"
                ? (settleHints.retryAfter ?? classified.retryAfter ?? null)
                : null,
            errorReason: errorReason ?? null,
            instability,
          });
        }

        if (settleHints.retryable && settleHints.nextSteps === "retry_later") {
          if (settleHints.retryAfter !== undefined) {
            c.header("Retry-After", String(settleHints.retryAfter));
          } else if (classified.retryAfter) {
            c.header("Retry-After", String(classified.retryAfter));
          }
        }

        c.header(X402_HEADERS.PAYMENT_RESPONSE, encodeBase64Json(settleHints));
        if (!releasedBoundPaymentOnTerminalFailure && !suppressUnboundPaymentPointers) {
          c.header("X-PAYMENT-ID", resultPaymentId);
        }

        return c.json(
          {
            error: classified.message,
            code: classified.code,
            ...(canonicalStatus ? { status: canonicalStatus } : {}),
            ...(terminalReason ? { terminalReason } : {}),
            retryable: settleHints.retryable,
            nextSteps: settleHints.nextSteps,
            ...(settleHints.retryAfter !== undefined ? { retryAfter: settleHints.retryAfter } : {}),
            paymentId: resultPaymentId,
            requestCorrelationId,
            ...(responseCheckStatusUrl ? { checkStatusUrl: responseCheckStatusUrl } : {}),
            asset,
            network: networkV2,
            resource: c.req.path,
            details: {
              errorReason: errorReason ?? undefined,
              ...(guardVerifyNonceDetail
                ? {
                    payerNonce: guardVerifyNonceDetail.payerNonce,
                    ...(guardVerifyNonceDetail.unavailableReason
                      ? { unavailableReason: guardVerifyNonceDetail.unavailableReason }
                      : {}),
                  }
                : {}),
            },
          },
          classified.httpStatus as 400 | 402 | 500 | 502 | 503
        );
      }
    }

    // Extract verified payer address and confirmed txid from settleResult
    const payerAddress = settleResult.payer;
    const confirmedTxid = settleResult.transaction;

    if (!payerAddress || payerAddress === c.env.X402_SERVER_ADDRESS) {
      if (activeHeldClaimId) {
        await releaseTxClaimInDO(c, txHash, activeHeldClaimId, log);
      }
      log.error("Could not extract verified payer address from payment");
      return c.json(
        { error: "Could not identify payer from payment", code: X402_ERROR_CODES.SENDER_MISMATCH },
        400
      );
    }

    if (!confirmedTxid) {
      if (activeHeldClaimId) {
        await releaseTxClaimInDO(c, txHash, activeHeldClaimId, log);
      }
      log.error("Confirmed settlement missing transaction ID");
      return c.json(
        { error: "Missing confirmed transaction ID", code: X402_ERROR_CODES.UNEXPECTED_SETTLE_ERROR },
        502
      );
    }

    const settleRecord = settleResult as Partial<SettleResult> & Record<string, unknown>;
    if (typeof settleRecord.paymentId === "string" && settleRecord.paymentId.startsWith("pay_")) {
      canonicalPaymentId = settleRecord.paymentId;
      hasRelayMintedPaymentId = true;
    }

    const isRelayMintedPaymentId = !settledViaHttpVerifier || hasRelayMintedPaymentId;
    const settleExt = settleRecord.extensions as Record<string, unknown> | undefined;
    const explicitHttpCheckStatusUrl =
      (typeof settleRecord.checkStatusUrl === "string" && settleRecord.checkStatusUrl.length > 0) ||
      (typeof settleExt?.checkStatusUrl === "string" && settleExt.checkStatusUrl.length > 0);
    const shouldTrackPaymentInDO =
      !settledViaHttpVerifier || hasRelayMintedPaymentId || explicitHttpCheckStatusUrl;

    if (
      isPaymentConsumed(
        txHash,
        isRelayMintedPaymentId ? canonicalPaymentId : undefined,
        confirmedTxid
      )
    ) {
      if (activeHeldClaimId) {
        await releaseTxClaimInDO(c, txHash, activeHeldClaimId, log);
      }
      return respondConsumedPayment(c, {
        paymentId: canonicalPaymentId,
        requestCorrelationId,
        asset,
        network: networkV2,
      });
    }

    // Atomically mark txHash as consumed in PaymentPollingDO across isolates before serving
    const consumeDOResult = await markTxConsumedInDO(
      c,
      {
        txHash,
        relayPaymentId: canonicalPaymentId,
        ...(callerSuppliedPaymentId ? { callerSuppliedPaymentId } : {}),
        txid: confirmedTxid,
        expectedRecipient: c.env.X402_SERVER_ADDRESS,
        minAmount: paymentRequirements.amount,
        asset,
        network: networkV2,
        verifiedPayer: payerAddress,
      },
      log
    );
    if ("error" in consumeDOResult) {
      log.error("PaymentPollingDO.markTxConsumed failed after settlement; failing closed with 503", {
        settledViaHttpVerifier,
        txHash,
        paymentId: canonicalPaymentId,
        confirmedTxid,
      });
      if (activeHeldClaimId) {
        await releaseTxClaimInDO(c, txHash, activeHeldClaimId, log);
      }
      return respondPaymentStoreUnavailable(c);
    }
    if (consumeDOResult.available && consumeDOResult.alreadyConsumed) {
      if (activeHeldClaimId) {
        await releaseTxClaimInDO(c, txHash, activeHeldClaimId, log);
      }
      markPaymentConsumed(txHash, canonicalPaymentId, confirmedTxid, isRelayMintedPaymentId);
      return respondConsumedPayment(c, {
        paymentId: canonicalPaymentId,
        requestCorrelationId,
        asset,
        network: networkV2,
      });
    }

    // Record consumed payment in the bounded per-isolate guard so same-isolate replay is refused immediately
    markPaymentConsumed(txHash, canonicalPaymentId, confirmedTxid, isRelayMintedPaymentId);

    const checkStatusUrl = shouldTrackPaymentInDO
      ? extractCheckStatusUrl(settleRecord, c.env.X402_FACILITATOR_URL, canonicalPaymentId)
      : undefined;

    log.info("Payment verified successfully", {
      txId: confirmedTxid,
      paymentId: canonicalPaymentId,
      requestCorrelationId,
      payerAddress,
      asset,
      network: networkV2,
      amount: paymentRequirements.amount,
      tier: dynamic ? "dynamic" : tier,
    });
    logPaymentEvent(log, "info", "payment.confirmed", {
      route: c.req.path,
      paymentId: canonicalPaymentId,
      status: "confirmed",
      checkStatusUrl,
      action: "allow_request",
    }, {
      txid: confirmedTxid,
      requestCorrelationId,
      payerAddress,
      asset,
      network: networkV2,
      amount: paymentRequirements.amount,
      tier: dynamic ? "dynamic" : tier,
    });

    if (shouldTrackPaymentInDO && checkStatusUrl) {
      // Register payment with PaymentPollingDO when a relay payment/status record exists
      trackPaymentInDO(
        c,
        {
          paymentId: canonicalPaymentId,
          checkStatusUrl,
          payerAddress,
          route: c.req.path,
          tokenType,
        },
        log
      );
    }

    // Store payment context for downstream use with separate requestCorrelationId, paymentId, and confirmedTxid
    c.set("x402", {
      payerAddress,
      settleResult,
      paymentPayload,
      paymentRequirements,
      priceEstimate,
      parsedBody,
      requestCorrelationId,
      paymentId: canonicalPaymentId,
      confirmedTxid,
    } as X402Context);

    // Add v2 response headers (base64 encoded)
    c.header(X402_HEADERS.PAYMENT_RESPONSE, encodeBase64Json(settleResult));
    c.header("X-PAYER-ADDRESS", payerAddress);
    c.header("X-PAYMENT-ID", canonicalPaymentId);

    return next();
  };
}
