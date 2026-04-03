import { describe, expect, test } from "bun:test";
import {
  CanonicalDomainBoundary,
  IN_FLIGHT_STATES,
  PAYMENT_STATES,
  PAYMENT_STATE_DEFAULT_DELIVERY,
} from "@aibtc/tx-schemas/core";
import { Hono } from "hono";
import { axDiscoveryRouter } from "../src/endpoints/ax-discovery";
import { response402 } from "../src/endpoints/schema";
import {
  PAYMENT_LIFECYCLE_METADATA,
  PAYMENT_PUBLIC_LIFECYCLE,
  PAYMENT_PUBLIC_STATES,
} from "../src/utils/payment-contract";
import { generateX402Manifest } from "../src/utils/x402-schema";

describe("payment contract parity", () => {
  test("keeps public payment states aligned with tx-schemas", () => {
    expect(PAYMENT_PUBLIC_STATES).toEqual(PAYMENT_STATES);
    expect(PAYMENT_LIFECYCLE_METADATA.publicStates).toEqual(PAYMENT_STATES);
    expect(PAYMENT_PUBLIC_LIFECYCLE).toBe(
      "requires_payment -> queued -> broadcasting -> mempool -> confirmed | failed | replaced | not_found"
    );
  });

  test("keeps immediate-pay-per-call lifecycle metadata aligned with canonical delivery rules", () => {
    expect(PAYMENT_LIFECYCLE_METADATA.submittedCallerFacing).toBe(false);
    expect(PAYMENT_LIFECYCLE_METADATA.inFlightIdentity).toBe(
      CanonicalDomainBoundary.paymentIdentity.field
    );
    expect(PAYMENT_LIFECYCLE_METADATA.deliverableState).toBe(
      CanonicalDomainBoundary.defaultProtectedResourceDelivery.deliverableStates[0]
    );
    expect(PAYMENT_LIFECYCLE_METADATA.deliveryMode).toBe("immediate-pay-per-call-compat");

    for (const state of IN_FLIGHT_STATES) {
      expect(PAYMENT_STATE_DEFAULT_DELIVERY[state]).toBe(false);
    }
    expect(PAYMENT_STATE_DEFAULT_DELIVERY.confirmed).toBe(true);
  });

  test("documents canonical caller-facing 402 status fields in OpenAPI", () => {
    const jsonSchema = response402.content["application/json"].schema as {
      oneOf: Array<{
        properties?: Record<string, unknown>;
      }>;
    };
    const paymentStatusError = jsonSchema.oneOf[1] as {
      properties: Record<string, unknown>;
    };

    expect(paymentStatusError.properties.status).toEqual({
      type: "string",
      enum: [...PAYMENT_PUBLIC_STATES],
    });
    expect(paymentStatusError.properties.paymentId).toEqual({ type: "string" });
    expect(paymentStatusError.properties.terminalReason).toEqual({ type: "string" });
    expect(paymentStatusError.properties.checkStatusUrl).toEqual({
      type: "string",
      format: "uri",
    });
  });

  test("publishes matching lifecycle metadata on discovery surfaces", async () => {
    const manifestBody = generateX402Manifest({
      network: "testnet",
      payTo: "STTESTPAYTOADDRESS",
      baseUrl: "https://x402.aibtc.dev",
    });

    expect(manifestBody.metadata.paymentLifecycle).toEqual(PAYMENT_LIFECYCLE_METADATA);

    const docsApp = new Hono();
    docsApp.route("/", axDiscoveryRouter);

    const llmsResponse = await docsApp.request("http://localhost/llms.txt");
    expect(llmsResponse.status).toBe(200);
    const llmsText = await llmsResponse.text();

    expect(llmsText).toContain(PAYMENT_PUBLIC_LIFECYCLE);
    expect(llmsText).toContain("`submitted` is never caller-facing");
    expect(llmsText).toContain("`paymentId` is the stable in-flight identity");
    expect(llmsText).toContain("immediate pay-per-call behavior during rollout");
    expect(llmsText).toContain("`checkStatusUrl`");
  });
});
