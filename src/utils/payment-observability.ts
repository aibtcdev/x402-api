import type { Logger } from "../types";
import type { CanonicalPaymentDetails } from "./payment-status";

export const PAYMENT_LOG_SERVICE = "x402-api";
export const PAYMENT_LOG_MIDDLEWARE = "x402";
export const PAYMENT_REPO_VERSION = "1.5.4";

type PaymentLogLevel = "debug" | "info" | "warn" | "error";

export interface PaymentLogContext {
  route: string;
  paymentId?: string;
  status?: string;
  terminalReason?: string;
  action: string;
  checkStatusUrl?: string;
  compatShimUsed?: boolean;
}

interface PaymentInstabilityInput {
  canonical?: CanonicalPaymentDetails | null;
  classifiedCode?: string;
  errorReason?: string;
  error?: string;
}

export function buildPaymentLogFields(
  context: PaymentLogContext,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    service: PAYMENT_LOG_SERVICE,
    route: context.route,
    middleware: PAYMENT_LOG_MIDDLEWARE,
    paymentId: context.paymentId ?? null,
    status: context.status ?? null,
    terminalReason: context.terminalReason ?? null,
    action: context.action,
    checkStatusUrl_present: Boolean(context.checkStatusUrl),
    compat_shim_used: Boolean(context.compatShimUsed),
    repo_version: PAYMENT_REPO_VERSION,
    ...extra,
  };
}

export function logPaymentEvent(
  log: Logger,
  level: PaymentLogLevel,
  event: string,
  context: PaymentLogContext,
  extra: Record<string, unknown> = {}
): void {
  const fields = buildPaymentLogFields(context, extra);

  switch (level) {
    case "debug":
      log.debug(event, fields);
      return;
    case "info":
      log.info(event, fields);
      return;
    case "warn":
      log.warn(event, fields);
      return;
    case "error":
      log.error(event, fields);
      return;
  }
}

export function derivePaymentInstability({
  canonical,
  classifiedCode,
  errorReason,
  error,
}: PaymentInstabilityInput): string | undefined {
  const combined = `${canonical?.terminalReason || ""} ${errorReason || ""} ${error || ""} ${classifiedCode || ""}`.toLowerCase();

  if (
    combined.includes("sender_nonce") ||
    combined.includes("badnonce") ||
    combined.includes("conflicting_nonce") ||
    combined.includes("conflictingnonceinmempool") ||
    combined.includes("nonce")
  ) {
    return "nonce_conflict";
  }

  if (combined.includes("queue_unavailable") || combined.includes("broadcast_failure") || combined.includes("settle")) {
    return "relay_failure";
  }

  if (combined.includes("invalid_transaction") || combined.includes("transaction_failed")) {
    return "invalid_transaction_state";
  }

  if (combined.includes("fee") || combined.includes("pricing")) {
    return "fee_estimation_issue";
  }

  return undefined;
}
