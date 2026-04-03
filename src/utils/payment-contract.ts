export const PAYMENT_PUBLIC_STATES = [
  "requires_payment",
  "queued",
  "broadcasting",
  "mempool",
  "confirmed",
  "failed",
  "replaced",
  "not_found",
] as const;

export const PAYMENT_PUBLIC_LIFECYCLE =
  "requires_payment -> queued -> broadcasting -> mempool -> confirmed | failed | replaced | not_found";

export const PAYMENT_LIFECYCLE_METADATA = {
  publicStates: PAYMENT_PUBLIC_STATES,
  submittedCallerFacing: false,
  inFlightIdentity: "paymentId",
  deliverableState: "confirmed",
  deliveryMode: "immediate-pay-per-call-compat",
} as const;
