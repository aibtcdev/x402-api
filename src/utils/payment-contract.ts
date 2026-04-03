import {
  CanonicalDomainBoundary,
  PAYMENT_STATES,
} from "@aibtc/tx-schemas/core";

export const PAYMENT_PUBLIC_STATES = PAYMENT_STATES;

export const PAYMENT_PUBLIC_LIFECYCLE =
  "requires_payment -> queued -> broadcasting -> mempool -> confirmed | failed | replaced | not_found";

export const PAYMENT_LIFECYCLE_METADATA = {
  publicStates: PAYMENT_PUBLIC_STATES,
  submittedCallerFacing: false,
  inFlightIdentity: CanonicalDomainBoundary.paymentIdentity.field,
  deliverableState: CanonicalDomainBoundary.defaultProtectedResourceDelivery.deliverableStates[0],
  deliveryMode: "immediate-pay-per-call-compat",
} as const;
