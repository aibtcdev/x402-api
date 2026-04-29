/**
 * Payment contract helper for x402-api.
 *
 * Thin re-export layer over @aibtc/tx-schemas subpaths.
 * Provides a single import point for all payment-lifecycle types used across
 * middleware, utilities, and Durable Objects in this service.
 *
 * No runtime logic lives here — only re-exports and type aliases.
 */

// =============================================================================
// Core state machine constants and schemas
// =============================================================================

export {
  // State enumerations
  PAYMENT_STATES,
  TRACKED_PAYMENT_STATES,
  IN_FLIGHT_STATES,
  TERMINAL_SUCCESS_STATES,
  TERMINAL_FAILURE_STATES,
  // Zod schemas for validation
  PaymentStateSchema,
  TrackedPaymentStateSchema,
  InFlightPaymentStateSchema,
  // Category mapping
  PAYMENT_STATE_TO_CATEGORY,
} from "@aibtc/tx-schemas/core";

// =============================================================================
// Terminal reason constants and schemas
// =============================================================================

export {
  TERMINAL_REASONS,
  TERMINAL_REASON_TO_STATE,
  TERMINAL_REASON_TO_CATEGORY,
  TERMINAL_REASON_CATEGORY_HANDLING,
  TerminalReasonSchema,
} from "@aibtc/tx-schemas/terminal-reasons";

export type {
  TerminalReason,
  TerminalReasonCategory,
} from "@aibtc/tx-schemas/terminal-reasons";

// =============================================================================
// HTTP response schemas for the relay HTTP /settle endpoint
// =============================================================================

export {
  HttpSettleSuccessResponseSchema,
  HttpSettleFailureResponseSchema,
  HttpSettleResponseSchema,
  HttpPaymentStatusResponseSchema,
} from "@aibtc/tx-schemas/http";

export type {
  HttpSettleResponse,
  HttpPaymentStatusResponse,
} from "@aibtc/tx-schemas/http";

// =============================================================================
// Type alias used by middleware and X402Context
//
// HttpSettleResponse is the tx-schemas equivalent of x402-stacks SettlementResponseV2.
// Both represent the HTTP /settle endpoint response. The tx-schemas version is a
// discriminated union on `success` which is structurally compatible.
// =============================================================================

export type { HttpSettleResponse as SettleResult } from "@aibtc/tx-schemas/http";
