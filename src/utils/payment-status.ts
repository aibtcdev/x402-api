import { InFlightPaymentStateSchema } from "@aibtc/tx-schemas/core";

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
