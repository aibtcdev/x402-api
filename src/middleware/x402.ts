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
  addressHashModeToVersion,
  Address,
  AuthType,
} from "@stacks/transactions";
import { stripHexPrefix } from "../utils/encoding";
import type { SettleResult } from "../services/payment-contract";
import type { TerminalReason } from "../services/payment-contract";
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

// =============================================================================
// Types
// =============================================================================

export interface X402MiddlewareOptions {
  /** Pricing tier for fixed pricing endpoints */
  tier?: PricingTier;
  /** Set to true for dynamic pricing (LLM endpoints) */
  dynamic?: boolean;
  /** Custom price estimator for dynamic pricing */
  estimator?: (body: unknown, tokenType: TokenType, log: Logger) => PriceEstimate;
  /** Max checkPayment poll attempts per request after RPC enqueue (default: 2) */
  rpcPollMaxAttempts?: number;
  /** Delay in ms between checkPayment poll attempts (default: 10ms) */
  rpcPollIntervalMs?: number;
}

export interface VerifiedTransactionOrigin {
  cleanHex: string;
  payerAddress: string;
  authType: number;
  nonce: string;
}

interface BoundRpcPayment {
  relayPaymentId: string;
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
}

interface RelayBoundStore {
  byRelayId: Map<string, BoundRpcPayment>;
  byCorrelationId: Map<string, BoundRpcPayment>;
  byTxHash: Map<string, BoundRpcPayment>;
}

// =============================================================================
// Constants, In-Flight Bound Store & Consumed Payment Replay Guard
// =============================================================================

const IN_FLIGHT_RPC_STATUSES = new Set([
  "queued",
  "queued_with_warning",
  "broadcasting",
  "mempool",
  "submitted",
]);

const TERMINAL_FAILURE_RPC_STATUSES = new Set([
  "failed",
  "replaced",
  "not_found",
]);

const RPC_CODE_TO_TERMINAL_REASON: Partial<Record<string, TerminalReason>> = {
  INVALID_TRANSACTION: "invalid_transaction",
  NOT_SPONSORED: "not_sponsored",
  SENDER_NONCE_STALE: "sender_nonce_stale",
  SENDER_NONCE_DUPLICATE: "sender_nonce_duplicate",
  SENDER_NONCE_GAP: "sender_nonce_gap",
  ORIGIN_CHAINING_LIMIT: "origin_chaining_limit",
  TOO_MUCH_CHAINING: "origin_chaining_limit",
  QUEUE_UNAVAILABLE: "queue_unavailable",
  SPONSOR_FAILURE: "sponsor_failure",
  SPONSOR_NONCE_CONFLICT: "sponsor_nonce_conflict",
  INTERNAL_ERROR: "internal_error",
  BROADCAST_FAILED: "broadcast_failure",
  TX_BROADCAST_ERROR: "broadcast_failure",
  BROADCAST_RATE_LIMITED: "broadcast_rate_limited",
  SETTLEMENT_FAILED: "chain_abort",
  PAYMENT_IDENTIFIER_CONFLICT: "unknown_payment_identity",
  SENDER_HAND_EXPIRED: "expired",
};

const BOUND_RPC_STORES = new WeakMap<object, RelayBoundStore>();

const MAX_CONSUMED_PAYMENTS_PER_SET = 10_000;
const MAX_BOUND_PAYMENTS_PER_STORE = 5_000;
const BOUND_PAYMENT_TTL_MS = 10 * 60 * 1_000;

/**
 * Per-isolate bounded fast guard tracking payments that have already been
 * confirmed and served in this Worker isolate. Cross-isolate replay of a
 * confirmed transaction is blocked by the per-attempt random `pay_` identifier,
 * the relay's `getReusablePaymentRecord` dropping terminal records, and
 * chain/relay rejection of already-mined transactions.
 */
const CONSUMED_PAYMENTS = {
  byTxHash: new Set<string>(),
  byRelayId: new Set<string>(),
  byConfirmedTxid: new Set<string>(),
};

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
  confirmedTxid?: string
): void {
  if (txHash) {
    addBoundedSetEntry(CONSUMED_PAYMENTS.byTxHash, txHash);
  }
  if (relayPaymentId && relayPaymentId.startsWith("pay_")) {
    addBoundedSetEntry(CONSUMED_PAYMENTS.byRelayId, relayPaymentId);
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
 * request path, query string, and SHA-256 of raw request body bytes so
 * a pending payment cannot be recovered against a modified request payload
 * or route. Fails closed (returns null and logs a warning) if reading the
 * body on a non-GET/HEAD request fails.
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
  if (BigInt(entry.minAmount) < BigInt(opts.minAmount)) {
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
  const canonicalStatus = settleResult && "status" in settleResult
    ? (settleResult as { status?: string }).status
    : undefined;

  if (
    canonicalStatus === "queued" ||
    canonicalStatus === "queued_with_warning" ||
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
  if (canonicalStatus === "failed") {
    return { code: X402_ERROR_CODES.TRANSACTION_FAILED, message: "Payment failed in settlement relay", httpStatus: 402 };
  }
  if (canonicalStatus === "replaced") {
    return { code: X402_ERROR_CODES.TRANSACTION_FAILED, message: "Payment was replaced, start a new payment flow", httpStatus: 402 };
  }
  if (canonicalStatus === "not_found") {
    return { code: X402_ERROR_CODES.INVALID_TRANSACTION_STATE, message: "Payment identity expired or was not found, start a new payment flow", httpStatus: 402 };
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
    rpcPollMaxAttempts = 2,
    rpcPollIntervalMs = 10,
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

    // Derive stable request correlation key for internal lookup only.
    // Use a fresh per-attempt random settlement ID for relay `payment-identifier`
    // so confirmed settlements cannot be replayed across the relay's 300s identifier cache.
    const requestCorrelationId = await deriveRequestCorrelationId(
      cleanTxHex,
      c.env.X402_SERVER_ADDRESS,
      paymentRequirements.amount,
      asset
    );
    const settlementAttemptId = "pay_" + crypto.randomUUID();
    const txHash = await sha256Hex(cleanTxHex.toLowerCase());

    // Refuse replay of an already-confirmed and served payment immediately
    if (isPaymentConsumed(txHash, callerSuppliedPaymentId)) {
      return respondConsumedPayment(c, {
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
        let verifiedPayer = txOrigin?.payerAddress;
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

        if (callerSuppliedPaymentId) {
          boundEntry =
            relayStore.byRelayId.get(callerSuppliedPaymentId) ??
            relayStore.byCorrelationId.get(callerSuppliedPaymentId);
          if (boundEntry) {
            const mismatchResponse = validateBoundPaymentForRecovery(c, boundEntry, {
              verifiedPayer,
              txHash,
              requireTxHashMatch: true,
              expectedRecipient: c.env.X402_SERVER_ADDRESS,
              asset,
              network: networkV2,
              minAmount: paymentRequirements.amount,
              requestBindingHash,
              requestCorrelationId,
            });
            if (mismatchResponse) {
              return mismatchResponse;
            }
          }
        }

        if (!boundEntry) {
          const existingByTx = relayStore.byTxHash.get(txHash);
          if (existingByTx) {
            const mismatchResponse = validateBoundPaymentForRecovery(c, existingByTx, {
              verifiedPayer,
              txHash,
              requireTxHashMatch: false,
              expectedRecipient: c.env.X402_SERVER_ADDRESS,
              asset,
              network: networkV2,
              minAmount: paymentRequirements.amount,
              requestBindingHash,
              requestCorrelationId,
            });
            if (mismatchResponse) {
              return mismatchResponse;
            }
            boundEntry = existingByTx;
          }
        }

        let initialSubmitStatus: string | undefined;
        let skipRpcPolling = false;

        if (!boundEntry) {
          const rpcResult = await c.env.X402_RELAY.submitPayment(
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

              const httpResult = (await verifier.settle(paymentPayload, {
                paymentRequirements,
              })) as unknown as SettleResult;
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
              }
              skipRpcPolling = true;
            } else {
              const mappedTerminalReason = RPC_CODE_TO_TERMINAL_REASON[rpcResult.code];
              settleResult = {
                success: false,
                transaction: "",
                network: networkV2,
                errorReason: rpcResult.code,
                ...(mappedTerminalReason ? { terminalReason: mappedTerminalReason } : {}),
                retryable: rpcResult.retryable,
                status: "failed",
                error: rpcResult.error,
              } as unknown as SettleResult;
              skipRpcPolling = true;
            }
          } else {
            if (typeof rpcResult.paymentId !== "string" || !rpcResult.paymentId.startsWith("pay_")) {
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
            initialSubmitStatus = rpcResult.status;

            if (isPaymentConsumed(txHash, relayPaymentId)) {
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

            boundEntry = {
              relayPaymentId,
              requestCorrelationId,
              requestBindingHash,
              txHash,
              verifiedPayer: verifiedPayer ?? "",
              checkStatusUrl: relayCheckStatusUrl,
              expectedRecipient: c.env.X402_SERVER_ADDRESS,
              minAmount: paymentRequirements.amount,
              asset,
              network: networkV2,
              createdAt: Date.now(),
            };
            saveBoundPayment(c.env.X402_RELAY, boundEntry);

            // Track enqueued payment in PaymentPollingDO using canonical relayPaymentId & relayCheckStatusUrl
            trackPaymentInDO(
              c,
              {
                paymentId: relayPaymentId,
                checkStatusUrl: relayCheckStatusUrl,
                payerAddress: verifiedPayer ?? "pending",
                route: c.req.path,
                tokenType,
              },
              log
            );
          }
        }

        if (!skipRpcPolling && boundEntry) {
          const relayPaymentId = boundEntry.relayPaymentId;
          canonicalPaymentId = relayPaymentId;
          let relayCheckStatusUrl = boundEntry.checkStatusUrl;
          let lastStatus = initialSubmitStatus ?? "queued";
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
                lastStatus = rawCheck.status === "submitted" ? "queued" : rawCheck.status;
                if (typeof rawCheck.checkStatusUrl === "string" && rawCheck.checkStatusUrl.length > 0) {
                  relayCheckStatusUrl = rawCheck.checkStatusUrl;
                  boundEntry.checkStatusUrl = relayCheckStatusUrl;
                }

                const checkReturnedPayer =
                  ((rawCheck as unknown as Record<string, unknown>).payer as string | undefined) ??
                  ((rawCheck as unknown as Record<string, unknown>).senderAddress as string | undefined);
                if (typeof checkReturnedPayer === "string" && checkReturnedPayer.length > 0) {
                  if (verifiedPayer && checkReturnedPayer !== verifiedPayer) {
                    removeBoundPayment(c.env.X402_RELAY, boundEntry);
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

                if (lastStatus === "confirmed" || TERMINAL_FAILURE_RPC_STATUSES.has(lastStatus)) {
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
                removeBoundPayment(c.env.X402_RELAY, boundEntry);
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

          if (TERMINAL_FAILURE_RPC_STATUSES.has(lastStatus)) {
            removeBoundPayment(c.env.X402_RELAY, boundEntry);
            const checkRetryable = (latestCheck as { retryable?: boolean } | undefined)?.retryable;
            settleResult = {
              success: false,
              transaction: latestCheck?.txid ?? "",
              network: networkV2,
              paymentId: relayPaymentId,
              status: lastStatus,
              terminalReason: latestCheck?.terminalReason,
              ...(typeof checkRetryable === "boolean" ? { retryable: checkRetryable } : {}),
              errorReason: latestCheck?.terminalReason ?? latestCheck?.error ?? lastStatus,
              checkStatusUrl: relayCheckStatusUrl,
            } as unknown as SettleResult;
          } else if (lastStatus !== "confirmed") {
            // Payment is still in-flight (queued, queued_with_warning, broadcasting, mempool, or poll timeout after enqueue).
            // Never invoke paid handler or emit payment.confirmed on enqueue!
            const pendingStatus = IN_FLIGHT_RPC_STATUSES.has(lastStatus) ? lastStatus : "queued";
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
        // HTTP facilitator path (when X402_RELAY is not bound)
        settleResult = (await verifier.settle(paymentPayload, {
          paymentRequirements,
        })) as unknown as SettleResult;
        const httpRelayId = (settleResult as { paymentId?: string }).paymentId;
        if (typeof httpRelayId === "string" && httpRelayId.startsWith("pay_")) {
          canonicalPaymentId = httpRelayId;
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
      log.error("Payment settlement failed", { ...settleResult });

      const settleRecord = settleResult as Partial<SettleResult> & Record<string, unknown>;
      const resultPaymentId =
        typeof settleRecord.paymentId === "string" && settleRecord.paymentId.startsWith("pay_")
          ? settleRecord.paymentId
          : canonicalPaymentId;
      const errorReason = (settleResult as { errorReason?: string }).errorReason;
      const canonicalStatus = (settleResult as { status?: string }).status;
      const terminalReason = (settleResult as { terminalReason?: string }).terminalReason;
      const explicitRetryable = (settleResult as { retryable?: boolean }).retryable;
      const classified = classifyPaymentError(errorReason || "settlement_failed", settleResult);
      const instability = derivePaymentInstability({
        classifiedCode: classified.code,
        errorReason,
      });

      const checkStatusUrl = extractCheckStatusUrl(
        settleRecord,
        c.env.X402_FACILITATOR_URL,
        resultPaymentId
      );

      if (classified.code === X402_ERROR_CODES.TRANSACTION_PENDING) {
        logPaymentEvent(log, "info", "payment.pending", {
          route: c.req.path,
          paymentId: resultPaymentId,
          status: "queued",
          checkStatusUrl,
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
          checkStatusUrl,
          action: getRetryAction(classified.code),
        }, {
          requestCorrelationId,
          classification_code: classified.code,
          http_status: classified.httpStatus,
          retry_after: classified.retryAfter ?? null,
          errorReason: errorReason ?? null,
          instability,
        });
      }

      const derivedHints = terminalReason
        ? computeDerivedHints(canonicalStatus ?? "failed", terminalReason)
        : null;
      const settleHints: DerivedHints =
        derivedHints ??
        (typeof explicitRetryable === "boolean"
          ? explicitRetryable
            ? {
                retryable: true,
                retryAfter: classified.retryAfter ?? 5,
                nextSteps: "retry_later",
              }
            : {
                retryable: false,
                nextSteps: "start_new_payment",
              }
          : computeDerivedHints(canonicalStatus ?? "failed", terminalReason) ??
            hintsFromClassifiedCode(classified));

      if (settleHints.retryAfter !== undefined) {
        c.header("Retry-After", String(settleHints.retryAfter));
      } else if (classified.retryAfter) {
        c.header("Retry-After", String(classified.retryAfter));
      }

      c.header(X402_HEADERS.PAYMENT_RESPONSE, encodeBase64Json(settleHints));
      c.header("X-PAYMENT-ID", resultPaymentId);

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
          checkStatusUrl,
          asset,
          network: networkV2,
          resource: c.req.path,
          details: {
            errorReason: errorReason ?? undefined,
          },
        },
        classified.httpStatus as 400 | 402 | 500 | 502 | 503
      );
    }

    // Extract verified payer address and confirmed txid from settleResult
    const payerAddress = settleResult.payer;
    const confirmedTxid = settleResult.transaction;

    if (!payerAddress || payerAddress === c.env.X402_SERVER_ADDRESS) {
      log.error("Could not extract verified payer address from payment");
      return c.json(
        { error: "Could not identify payer from payment", code: X402_ERROR_CODES.SENDER_MISMATCH },
        400
      );
    }

    if (!confirmedTxid) {
      log.error("Confirmed settlement missing transaction ID");
      return c.json(
        { error: "Missing confirmed transaction ID", code: X402_ERROR_CODES.UNEXPECTED_SETTLE_ERROR },
        502
      );
    }

    const settleRecord = settleResult as Partial<SettleResult> & Record<string, unknown>;
    if (typeof settleRecord.paymentId === "string" && settleRecord.paymentId.startsWith("pay_")) {
      canonicalPaymentId = settleRecord.paymentId;
    }

    if (isPaymentConsumed(txHash, canonicalPaymentId, confirmedTxid)) {
      return respondConsumedPayment(c, {
        paymentId: canonicalPaymentId,
        requestCorrelationId,
        asset,
        network: networkV2,
      });
    }

    // Record consumed payment in the bounded per-isolate guard so same-isolate replay is refused immediately
    markPaymentConsumed(txHash, canonicalPaymentId, confirmedTxid);

    const checkStatusUrl = extractCheckStatusUrl(
      settleRecord,
      c.env.X402_FACILITATOR_URL,
      canonicalPaymentId
    );

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

    // Register payment with PaymentPollingDO using canonicalPaymentId & checkStatusUrl
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
