import {
  HttpPaymentStatusResponseSchema,
  type HttpPaymentStatusResponse,
} from "@aibtc/tx-schemas/http";
import {
  InFlightPaymentStateSchema,
  TrackedPaymentStateSchema,
  type TrackedPaymentState,
} from "@aibtc/tx-schemas/core";
import {
  TERMINAL_REASON_TO_STATE,
  TerminalReasonSchema,
  type TerminalReason,
} from "@aibtc/tx-schemas/terminal-reasons";

type UnknownRecord = Record<string, unknown>;

const STATUS_ALIASES: Record<string, TrackedPaymentState> = {
  queued_with_warning: "queued",
  submitted: "queued",
};

const STATUS_KEYS = ["status", "state"] as const;
const TERMINAL_REASON_KEYS = ["terminalReason", "reason"] as const;

export interface CanonicalPaymentDetails {
  paymentId?: string;
  status?: TrackedPaymentState;
  terminalReason?: TerminalReason;
  retryable?: boolean;
  error?: string;
  errorCode?: string;
  checkStatusUrl?: string;
  txid?: string;
  compatShimUsed: boolean;
  source: "canonical" | "inferred";
}

export interface RetryDecisionContext {
  paymentId?: string;
  status?: TrackedPaymentState;
  terminalReason?: TerminalReason;
  retryable?: boolean;
  compatShimUsed: boolean;
  source: "canonical" | "inferred" | "legacy";
}

interface ExtractedField<T> {
  value?: T;
  compatShimUsed: boolean;
}

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : null;
}

function firstString(record: UnknownRecord | null, keys: readonly string[]): string | undefined {
  if (!record) return undefined;

  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function extractPaymentId(record: UnknownRecord | null): string | undefined {
  if (!record) return undefined;

  const topLevelPaymentId = firstString(record, ["paymentId"]);
  if (topLevelPaymentId) return topLevelPaymentId;

  const extensions = asRecord(record.extensions);
  const paymentIdentifier = asRecord(extensions?.["payment-identifier"]);
  const info = asRecord(paymentIdentifier?.info);
  const extensionPaymentId = firstString(info, ["id"]);
  if (extensionPaymentId) return extensionPaymentId;

  const details = asRecord(record.details);
  const nestedPaymentId = extractPaymentId(details);
  if (nestedPaymentId) return nestedPaymentId;

  const canonical = asRecord(details?.canonical);
  return firstString(canonical, ["paymentId"]);
}

function noneExtracted<T>(): ExtractedField<T> {
  return { value: undefined, compatShimUsed: false };
}

function firstExtracted<T>(...candidates: Array<ExtractedField<T>>): ExtractedField<T> {
  for (const candidate of candidates) {
    if (candidate.value !== undefined) {
      return candidate;
    }
  }

  return noneExtracted();
}

function normalizeStatus(value: unknown): ExtractedField<TrackedPaymentState> {
  if (typeof value !== "string" || value.length === 0) return noneExtracted();

  const normalized = STATUS_ALIASES[value] ?? value;
  const parsed = TrackedPaymentStateSchema.safeParse(normalized);

  return parsed.success
    ? { value: parsed.data, compatShimUsed: normalized !== value }
    : noneExtracted();
}

function inferLegacyStatus(value: string | undefined): ExtractedField<TrackedPaymentState> {
  if (!value) return noneExtracted();

  const lower = value.toLowerCase();

  if (lower.includes("transaction_pending")) return { value: "queued", compatShimUsed: true };
  if (lower.includes("queued_with_warning")) return { value: "queued", compatShimUsed: true };
  if (lower.includes("submitted")) return { value: "queued", compatShimUsed: true };
  if (lower.includes("broadcasting")) return { value: "broadcasting", compatShimUsed: true };
  if (lower.includes("mempool")) return { value: "mempool", compatShimUsed: true };

  return noneExtracted();
}

function extractStatus(record: UnknownRecord | null): ExtractedField<TrackedPaymentState> {
  if (!record) return noneExtracted();

  for (const key of STATUS_KEYS) {
    const status = normalizeStatus(record[key]);
    if (status.value) return status;
  }

  const details = asRecord(record.details);
  const canonical = asRecord(details?.canonical);

  return firstExtracted(
    extractStatus(details),
    extractStatus(canonical),
    inferLegacyStatus(firstString(record, ["errorReason", "error", "message", "code"]))
  );
}

function normalizeTerminalReason(value: unknown): ExtractedField<TerminalReason> {
  if (typeof value !== "string" || value.length === 0) return noneExtracted();

  const parsed = TerminalReasonSchema.safeParse(value);
  return parsed.success ? { value: parsed.data, compatShimUsed: false } : noneExtracted();
}

function inferLegacyTerminalReason(value: string | undefined): ExtractedField<TerminalReason> {
  if (!value) return noneExtracted();

  const lower = value.toLowerCase();

  if (
    lower.includes("client_bad_nonce") ||
    lower.includes("conflicting_nonce") ||
    lower.includes("conflictingnonceinmempool") ||
    lower.includes("conflicting nonce") ||
    lower.includes("nonce already used") ||
    lower.includes("nonce too low")
  ) {
    return { value: "sender_nonce_duplicate", compatShimUsed: true };
  }

  if (lower.includes("missing nonce") || lower.includes("client_missing_nonce") || lower.includes("nonce gap")) {
    return { value: "sender_nonce_gap", compatShimUsed: true };
  }

  if (lower.includes("stale nonce") || lower.includes("expired nonce")) {
    return { value: "sender_nonce_stale", compatShimUsed: true };
  }

  if (lower.includes("queue_unavailable") || lower.includes("facilitator_unavailable")) {
    return { value: "queue_unavailable", compatShimUsed: true };
  }

  if (lower.includes("sponsor_failure")) return { value: "sponsor_failure", compatShimUsed: true };
  if (lower.includes("broadcast_failed") || lower.includes("broadcast failure")) return { value: "broadcast_failure", compatShimUsed: true };
  if (lower.includes("chain_abort")) return { value: "chain_abort", compatShimUsed: true };
  if (lower.includes("internal_error")) return { value: "internal_error", compatShimUsed: true };
  if (lower.includes("nonce_replacement")) return { value: "nonce_replacement", compatShimUsed: true };
  if (lower.includes("superseded")) return { value: "superseded", compatShimUsed: true };
  if (lower.includes("unknown_payment_identity")) return { value: "unknown_payment_identity", compatShimUsed: true };
  if (lower.includes("expired")) return { value: "expired", compatShimUsed: true };
  if (lower.includes("invalid_transaction") || lower.includes("transaction_failed")) return { value: "invalid_transaction", compatShimUsed: true };

  return noneExtracted();
}

function extractTerminalReason(record: UnknownRecord | null): ExtractedField<TerminalReason> {
  if (!record) return noneExtracted();

  for (const key of TERMINAL_REASON_KEYS) {
    const terminalReason = normalizeTerminalReason(record[key]);
    if (terminalReason.value) return terminalReason;
  }

  const details = asRecord(record.details);
  const canonical = asRecord(details?.canonical);

  return firstExtracted(
    extractTerminalReason(details),
    extractTerminalReason(canonical),
    inferLegacyTerminalReason(firstString(record, ["errorReason", "error", "message", "code"]))
  );
}

function extractCheckStatusUrl(record: UnknownRecord | null): string | undefined {
  if (!record) return undefined;

  const topLevel = firstString(record, ["checkStatusUrl"]);
  if (topLevel) return topLevel;

  const details = asRecord(record.details);
  const nestedDetails = extractCheckStatusUrl(details);
  if (nestedDetails) return nestedDetails;

  const canonical = asRecord(details?.canonical);
  return extractCheckStatusUrl(canonical);
}

function extractRetryable(record: UnknownRecord | null): boolean | undefined {
  if (!record) return undefined;

  if (typeof record.retryable === "boolean") return record.retryable;

  const details = asRecord(record.details);
  const nestedDetails = extractRetryable(details);
  if (nestedDetails !== undefined) return nestedDetails;

  const canonical = asRecord(details?.canonical);
  return extractRetryable(canonical);
}

function coerceHttpPaymentStatus(record: UnknownRecord | null): HttpPaymentStatusResponse | null {
  if (!record) return null;

  const paymentId = extractPaymentId(record);
  const status = extractStatus(record).value;

  if (!paymentId || !status) return null;

  const terminalReason = extractTerminalReason(record).value;
  const retryable = extractRetryable(record);
  const error = firstString(record, ["error"]);
  const errorCode = firstString(record, ["errorCode", "code"]);
  const checkStatusUrl = extractCheckStatusUrl(record);
  const txid = firstString(record, ["txid", "transaction"]);

  const candidate: UnknownRecord = {
    paymentId,
    status,
    ...(terminalReason ? { terminalReason } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
    ...(error ? { error } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(checkStatusUrl ? { checkStatusUrl } : {}),
    ...(txid ? { txid } : {}),
  };

  const parsed = HttpPaymentStatusResponseSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function inferFromTerminalReason(
  record: UnknownRecord | null,
  terminalReason: TerminalReason
): CanonicalPaymentDetails {
  const paymentId = extractPaymentId(record);
  const status = TERMINAL_REASON_TO_STATE[terminalReason];
  const retryable = extractRetryable(record);

  return {
    paymentId,
    status,
    terminalReason,
    retryable,
    error: firstString(record, ["error"]),
    errorCode: firstString(record, ["errorCode", "code"]),
    checkStatusUrl: extractCheckStatusUrl(record),
    txid: firstString(record, ["txid", "transaction"]),
    compatShimUsed: true,
    source: "inferred",
  };
}

export function extractCanonicalPaymentDetails(input: unknown): CanonicalPaymentDetails | null {
  const record = asRecord(input);
  if (!record) return null;

  const status = extractStatus(record);
  const terminalReason = extractTerminalReason(record);
  const canonical = coerceHttpPaymentStatus(record);
  if (canonical) {
    return {
      paymentId: canonical.paymentId,
      status: canonical.status,
      terminalReason: canonical.terminalReason,
      retryable: canonical.retryable,
      error: canonical.error,
      errorCode: canonical.errorCode,
      checkStatusUrl: canonical.checkStatusUrl,
      txid: canonical.txid,
      compatShimUsed: status.compatShimUsed || terminalReason.compatShimUsed,
      source: "canonical",
    };
  }

  if (terminalReason.value) {
    return inferFromTerminalReason(record, terminalReason.value);
  }

  const paymentId = extractPaymentId(record);
  const extractedStatus = status.value;

  if (!paymentId && !extractedStatus) {
    return null;
  }

  return {
    paymentId,
    status: extractedStatus,
    retryable: extractRetryable(record),
    error: firstString(record, ["error"]),
    errorCode: firstString(record, ["errorCode", "code"]),
    checkStatusUrl: extractCheckStatusUrl(record),
    txid: firstString(record, ["txid", "transaction"]),
    compatShimUsed: status.compatShimUsed,
    source: "inferred",
  };
}

export function getRetryDecisionContext(input: unknown): RetryDecisionContext | null {
  const canonical = extractCanonicalPaymentDetails(input);
  if (canonical) {
    return {
      paymentId: canonical.paymentId,
      status: canonical.status,
      terminalReason: canonical.terminalReason,
      retryable: canonical.retryable,
      compatShimUsed: canonical.compatShimUsed,
      source: canonical.source,
    };
  }

  const record = asRecord(input);
  if (!record) return null;

  const terminalReason = extractTerminalReason(record);
  if (terminalReason.value) {
    return {
      paymentId: extractPaymentId(record),
      status: TERMINAL_REASON_TO_STATE[terminalReason.value],
      terminalReason: terminalReason.value,
      retryable: extractRetryable(record),
      compatShimUsed: terminalReason.compatShimUsed,
      source: "inferred",
    };
  }

  return null;
}

export function isInFlightPaymentState(
  status: string | undefined
): status is "queued" | "broadcasting" | "mempool" {
  const parsed = InFlightPaymentStateSchema.safeParse(status);
  return parsed.success;
}

export function isSenderRebuildTerminalReason(reason: string | undefined): boolean {
  return (
    reason === "sender_nonce_stale" ||
    reason === "sender_nonce_gap" ||
    reason === "sender_nonce_duplicate"
  );
}

export function isRelayRetryableTerminalReason(reason: string | undefined): boolean {
  return (
    reason === "queue_unavailable" ||
    reason === "sponsor_failure" ||
    reason === "broadcast_failure" ||
    reason === "chain_abort" ||
    reason === "internal_error"
  );
}
