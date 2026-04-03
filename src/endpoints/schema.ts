/**
 * Shared Schema Definitions
 *
 * Common OpenAPI schema components used across endpoints to reduce duplication.
 */

import { PAYMENT_PUBLIC_STATES } from "../utils/payment-contract";

// =============================================================================
// Common Parameters
// =============================================================================

/**
 * Token type query parameter (STX, sBTC, USDCx)
 * Used by all paid endpoints to specify payment token
 */
export const tokenTypeParam = {
  name: "tokenType",
  in: "query" as const,
  required: false,
  schema: { type: "string" as const, enum: ["STX", "sBTC", "USDCx"], default: "STX" },
  description: "Payment token type",
};

// =============================================================================
// Common Response Schemas
// =============================================================================

const paymentLifecycleSchema = {
  type: "object" as const,
  properties: {
    publicStates: {
      type: "array" as const,
      items: {
        type: "string" as const,
        enum: [...PAYMENT_PUBLIC_STATES],
      },
    },
    submittedCallerFacing: { type: "boolean" as const, enum: [false] },
    inFlightIdentity: { type: "string" as const, enum: ["paymentId"] },
    deliverableState: { type: "string" as const, enum: ["confirmed"] },
    deliveryMode: { type: "string" as const, enum: ["immediate-pay-per-call-compat"] },
  },
};

const paymentRequiredSchema = {
  type: "object" as const,
  required: ["x402Version", "resource", "accepts"],
  properties: {
    x402Version: { type: "integer" as const, enum: [2] },
    resource: {
      type: "object" as const,
      required: ["url"],
      properties: {
        url: { type: "string" as const },
        description: { type: "string" as const },
        mimeType: { type: "string" as const },
      },
    },
    accepts: {
      type: "array" as const,
      items: {
        type: "object" as const,
        required: ["scheme", "network", "amount", "asset", "payTo", "maxTimeoutSeconds"],
        properties: {
          scheme: { type: "string" as const, enum: ["exact"] },
          network: { type: "string" as const },
          amount: { type: "string" as const },
          asset: { type: "string" as const },
          payTo: { type: "string" as const },
          maxTimeoutSeconds: { type: "integer" as const },
          extra: { type: "object" as const, additionalProperties: true },
        },
      },
    },
    metadata: {
      type: "object" as const,
      properties: {
        paymentLifecycle: paymentLifecycleSchema,
      },
    },
    extensions: { type: "object" as const, additionalProperties: true },
  },
};

const paymentStatusErrorSchema = {
  type: "object" as const,
  required: ["error", "code", "asset", "network", "resource"],
  properties: {
    error: { type: "string" as const },
    code: { type: "string" as const },
    paymentId: { type: "string" as const },
    status: {
      type: "string" as const,
      enum: [...PAYMENT_PUBLIC_STATES],
    },
    terminalReason: { type: "string" as const },
    retryable: { type: "boolean" as const },
    checkStatusUrl: { type: "string" as const, format: "uri" },
    asset: { type: "string" as const },
    network: { type: "string" as const },
    resource: { type: "string" as const },
    details: {
      type: "object" as const,
      additionalProperties: true,
      properties: {
        errorReason: { type: "string" as const },
        canonical: {
          type: "object" as const,
          additionalProperties: true,
          properties: {
            paymentId: { type: "string" as const },
            status: {
              type: "string" as const,
              enum: [...PAYMENT_PUBLIC_STATES],
            },
            terminalReason: { type: "string" as const },
            retryable: { type: "boolean" as const },
            error: { type: "string" as const },
            errorCode: { type: "string" as const },
            checkStatusUrl: { type: "string" as const, format: "uri" },
            txid: { type: "string" as const },
            compatShimUsed: { type: "boolean" as const },
            source: { type: "string" as const, enum: ["canonical", "inferred"] },
          },
        },
      },
    },
  },
};

/** Standard 402 response: either an unpaid challenge or canonical payment-status error */
export const response402 = {
  description: "Payment required or canonical payment-status retry response",
  content: {
    "application/json": {
      schema: {
        oneOf: [paymentRequiredSchema, paymentStatusErrorSchema],
      },
    },
  },
};

/** Standard 400 Bad Request response */
export const response400 = { description: "Invalid request" };

// =============================================================================
// Common Property Schemas
// =============================================================================

/** ok: boolean property */
export const okProp = { type: "boolean" as const };

/** tokenType: string property */
export const tokenTypeProp = { type: "string" as const };

/** string property */
export const stringProp = { type: "string" as const };

/** boolean property */
export const boolProp = { type: "boolean" as const };

/** integer property */
export const intProp = { type: "integer" as const };

/** object property */
export const objectProp = { type: "object" as const };

// =============================================================================
// Parameter Builders
// =============================================================================

/**
 * Create a path parameter
 */
export function pathParam(name: string, description: string) {
  return {
    name,
    in: "path" as const,
    required: true,
    schema: stringProp,
    description,
  };
}

/**
 * Create an optional string query parameter
 */
export function queryParamString(name: string, description: string) {
  return {
    name,
    in: "query" as const,
    required: false,
    schema: { type: "string" as const },
    description,
  };
}

/**
 * Create an optional integer query parameter with default
 */
export function queryParamInt(name: string, description: string, defaultValue: number) {
  return {
    name,
    in: "query" as const,
    required: false,
    schema: { type: "integer" as const, default: defaultValue },
    description,
  };
}
