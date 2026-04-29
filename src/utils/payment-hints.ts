/**
 * Payment hint computation — pure utility, no DO or runtime dependencies.
 *
 * Extracted from PaymentPollingDO so it can be unit-tested with bun:test
 * outside the Cloudflare Workers runtime, and reused by Phase 6
 * error-response shaping.
 */

import {
  TERMINAL_REASON_TO_CATEGORY,
  TERMINAL_REASON_CATEGORY_HANDLING,
} from "../services/payment-contract";
import type { TerminalReason } from "../services/payment-contract";

// =============================================================================
// Types
// =============================================================================

export interface DerivedHints {
  retryable: boolean;
  retryAfter?: number;   // seconds
  nextSteps: string;     // stable token: rebuild_and_resign | retry_later | start_new_payment | fix_and_resend | wait_for_confirmation
}

// =============================================================================
// Terminal status set (must match PaymentPollingDO)
// =============================================================================

const TERMINAL_STATUSES = new Set([
  "confirmed",
  "failed",
  "replaced",
  "not_found",
]);

// =============================================================================
// computeDerivedHints — pure function
// =============================================================================

/**
 * Compute structured error hints from a terminal payment status/reason pair.
 *
 * Returns null for non-terminal payments (no hints yet).
 * Maps terminal reason → category → nextSteps token:
 *   sender     → rebuild_and_resign (retryable, no retryAfter)
 *   relay      → retry_later        (retryable, retryAfter=30)
 *   settlement → retry_later        (retryable, retryAfter=30)
 *   replacement→ start_new_payment  (not retryable)
 *   identity   → start_new_payment  (not retryable)
 *   validation → fix_and_resend     (not retryable)
 *   confirmed  → wait_for_confirmation (not retryable — deliver was successful)
 */
export function computeDerivedHints(
  status: string,
  terminalReason?: string
): DerivedHints | null {
  // Non-terminal: no hints yet
  if (!TERMINAL_STATUSES.has(status)) {
    return null;
  }

  // confirmed — delivery should proceed
  if (status === "confirmed") {
    return {
      retryable: false,
      nextSteps: "wait_for_confirmation",
    };
  }

  // failed/replaced/not_found without a specific reason
  if (!terminalReason) {
    return {
      retryable: false,
      nextSteps: "start_new_payment",
    };
  }

  const reason = terminalReason as TerminalReason;
  const category = TERMINAL_REASON_TO_CATEGORY[reason];

  if (!category) {
    // Unknown reason — conservative: don't retry
    return {
      retryable: false,
      nextSteps: "start_new_payment",
    };
  }

  switch (category) {
    case "sender":
      return {
        retryable: true,
        nextSteps: "rebuild_and_resign",
      };
    case "relay":
    case "settlement":
      return {
        retryable: true,
        retryAfter: 30,
        nextSteps: "retry_later",
      };
    case "replacement":
    case "identity":
      return {
        retryable: false,
        nextSteps: "start_new_payment",
      };
    case "validation":
      return {
        retryable: false,
        nextSteps: "fix_and_resend",
      };
    default: {
      // Exhaustive — TypeScript errors if a new category is added without handling
      const _exhaustive: never = category;
      void _exhaustive;
      return {
        retryable: false,
        nextSteps: "start_new_payment",
      };
    }
  }
}
