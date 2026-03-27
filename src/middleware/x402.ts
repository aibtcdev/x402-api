/**
 * x402 Payment Middleware (V2 Protocol)
 *
 * Verifies x402 payments for API requests using the x402-stacks library.
 * Implements Coinbase-compatible x402 v2 protocol.
 */

import type { Context, MiddlewareHandler } from "hono";
import {
  X402PaymentVerifier,
  networkToCAIP2,
  X402_HEADERS,
  X402_ERROR_CODES,
} from "x402-stacks";
import type {
  NetworkV2,
  PaymentRequiredV2,
  PaymentRequirementsV2,
  PaymentPayloadV2,
  SettlementResponseV2,
} from "x402-stacks";
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
} from "../types";
import {
  validateTokenType,
  getFixedTierEstimate,
  estimateChatPayment,
} from "../services/pricing";
import { lookupModel } from "../services/model-cache";
import { getEndpointMetadata, buildBazaarExtension } from "../bazaar";

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

/** Error code for relay-side nonce conflicts (retryable, not in x402-stacks X402_ERROR_CODES) */
const NONCE_CONFLICT_CODE = "NONCE_CONFLICT";

/**
 * Classify payment errors for appropriate response
 */
function classifyPaymentError(error: unknown, settleResult?: Partial<SettlementResponseV2>): {
  code: string;
  message: string;
  httpStatus: number;
  retryable: boolean;
  retryAfter?: number;
  nextSteps: string;
} {
  const errorStr = String(error).toLowerCase();
  const resultError = settleResult?.errorReason?.toLowerCase() || "";
  const combined = `${errorStr} ${resultError}`;

  if (combined.includes("fetch") || combined.includes("network") || combined.includes("timeout")) {
    return { code: X402_ERROR_CODES.UNEXPECTED_SETTLE_ERROR, message: "Network error with settlement relay", httpStatus: 502, retryable: true, retryAfter: 5, nextSteps: "Retry the request — this is a transient network error with the settlement relay" };
  }

  if (combined.includes("503") || combined.includes("unavailable")) {
    return { code: X402_ERROR_CODES.UNEXPECTED_SETTLE_ERROR, message: "Settlement relay temporarily unavailable", httpStatus: 503, retryable: true, retryAfter: 30, nextSteps: "Wait 30 seconds and retry — the settlement relay is temporarily unavailable" };
  }

  if (combined.includes("insufficient") || combined.includes("balance")) {
    return { code: X402_ERROR_CODES.INSUFFICIENT_FUNDS, message: "Insufficient funds in wallet", httpStatus: 402, retryable: false, nextSteps: "Check your wallet balance and top up before retrying" };
  }

  // Specific nonce conflict case — check before the broad "nonce" match below
  if (combined.includes("conflicting_nonce") || combined.includes("sender_nonce_duplicate")) {
    return { code: NONCE_CONFLICT_CODE, message: "Relay nonce conflict during settlement", httpStatus: 409, retryable: true, retryAfter: 2, nextSteps: "Retry the same request in 2 seconds — this is a transient relay nonce conflict that resolves automatically" };
  }

  if (combined.includes("expired") || combined.includes("nonce")) {
    return { code: X402_ERROR_CODES.INVALID_TRANSACTION_STATE, message: "Payment expired, please sign a new payment", httpStatus: 402, retryable: false, nextSteps: "Sign a new payment — the transaction nonce or timestamp has expired" };
  }

  if (combined.includes("amount") && (combined.includes("low") || combined.includes("minimum"))) {
    return { code: X402_ERROR_CODES.AMOUNT_INSUFFICIENT, message: "Payment amount below minimum required", httpStatus: 402, retryable: false, nextSteps: "Increase the payment amount to meet the minimum required for this endpoint" };
  }

  // Relay-specific errors — check before broad "invalid"/"signature" to avoid misclassification
  if (combined.includes("broadcast_failed") || combined.includes("broadcast failed")) {
    return { code: X402_ERROR_CODES.BROADCAST_FAILED, message: "Settlement relay broadcast failed, please retry", httpStatus: 502, retryable: true, retryAfter: 5, nextSteps: "Retry the request — the settlement relay failed to broadcast the transaction" };
  }

  if (combined.includes("transaction_failed") || combined.includes("transaction failed")) {
    return { code: X402_ERROR_CODES.TRANSACTION_FAILED, message: "Transaction failed in settlement relay", httpStatus: 402, retryable: false, nextSteps: "Sign a new payment — the transaction failed in the settlement relay" };
  }

  if (combined.includes("transaction_pending") || combined.includes("transaction pending")) {
    return { code: X402_ERROR_CODES.TRANSACTION_PENDING, message: "Transaction pending in settlement relay, please retry", httpStatus: 402, retryable: true, retryAfter: 10, nextSteps: "Wait 10 seconds and retry — your previous transaction is still pending" };
  }

  if (combined.includes("sender_mismatch") || combined.includes("sender mismatch")) {
    return { code: X402_ERROR_CODES.SENDER_MISMATCH, message: "Payment sender does not match expected address", httpStatus: 400, retryable: false, nextSteps: "Ensure you are signing from the correct wallet address" };
  }

  if (combined.includes("unsupported_scheme") || combined.includes("unsupported scheme")) {
    return { code: X402_ERROR_CODES.UNSUPPORTED_SCHEME, message: "Unsupported payment scheme", httpStatus: 400, retryable: false, nextSteps: "Use a supported payment scheme (exact) for this endpoint" };
  }

  // Broad matches last — catch generic "invalid"/"signature" errors not matched above
  if (combined.includes("invalid") || combined.includes("signature")) {
    return { code: X402_ERROR_CODES.INVALID_PAYLOAD, message: "Invalid payment signature", httpStatus: 400, retryable: false, nextSteps: "Re-sign the payment with a valid signature" };
  }

  if (combined.includes("recipient")) {
    return { code: X402_ERROR_CODES.RECIPIENT_MISMATCH, message: "Payment recipient mismatch", httpStatus: 400, retryable: false, nextSteps: "Verify the recipient address in the payment payload matches this endpoint" };
  }

  return { code: X402_ERROR_CODES.UNEXPECTED_SETTLE_ERROR, message: "Payment processing error", httpStatus: 500, retryable: true, retryAfter: 5, nextSteps: "Retry the request with the same payment — if the issue persists after 3 retries, sign a new payment" };
}

// =============================================================================
// Middleware Factory
// =============================================================================

/**
 * Create x402 v2 payment middleware
 *
 * @param options - Configuration for the middleware
 * @returns Hono middleware handler
 *
 * @example Fixed tier pricing:
 * ```ts
 * app.post("/hash/sha256", x402Middleware({ tier: "standard" }), handleHash);
 * ```
 *
 * @example Dynamic pricing for LLM:
 * ```ts
 * app.post("/inference/chat", x402Middleware({ dynamic: true }), handleChat);
 * ```
 */
export function x402Middleware(
  options: X402MiddlewareOptions = {}
): MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> {
  const { tier = "standard", dynamic = false, estimator } = options;

  return async (c, next) => {
    const log = c.var.logger;

    // Check if x402 is configured
    if (!c.env.X402_SERVER_ADDRESS) {
      log.warn("X402_SERVER_ADDRESS not configured, skipping payment verification");
      return next();
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
      // Dynamic pricing - need to parse body for estimation
      try {
        parsedBody = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON in request body" }, 400);
      }

      if (estimator) {
        priceEstimate = estimator(parsedBody, tokenType, log);
      } else {
        // Default: assume chat completion request
        const chatRequest = parsedBody as ChatCompletionRequest;

        // Validate model field before any downstream calls that assume a string
        if (typeof chatRequest.model !== "string" || chatRequest.model.length === 0) {
          return c.json({ error: "Missing or invalid 'model' field", code: "invalid_request" }, 400);
        }

        // Validate messages field before calling estimateChatPayment, which expects a non-empty
        // array. This is request validation; downstream token estimation now guards non-array/empty
        // values and returns a safe default instead of throwing.
        if (!Array.isArray(chatRequest.messages) || chatRequest.messages.length === 0) {
          return c.json({ error: "Missing or invalid 'messages' field: must be a non-empty array", code: "invalid_request" }, 400);
        }

        // Pre-payment model validation: reject unknown models before issuing 402
        if (c.env.OPENROUTER_API_KEY) {
          const modelResult = await lookupModel(chatRequest.model, c.env.OPENROUTER_API_KEY, log);
          if (modelResult.valid && modelResult.degraded) {
            // Cache was empty after refresh attempt — allow the request but warn operators
            log.warn("Model cache degraded at middleware — skipping pre-payment model validation", {
              model: chatRequest.model,
            });
          } else if (!modelResult.valid) {
            return c.json(
              { error: modelResult.error, code: "invalid_model", model: chatRequest.model },
              400
            );
          }
          // Use live registry pricing if available, otherwise fall through to hardcoded table
          priceEstimate = estimateChatPayment(chatRequest, tokenType, log, modelResult.pricing);
        } else {
          priceEstimate = estimateChatPayment(chatRequest, tokenType, log);
        }
      }
    } else {
      // Fixed tier pricing
      priceEstimate = getFixedTierEstimate(tier, tokenType);
    }

    // Skip payment for free tier
    if (tier === "free" && !dynamic) {
      c.set("x402", {
        payerAddress: "anonymous",
        settleResult: { success: true, transaction: "", network: networkToCAIP2(c.env.X402_NETWORK), payer: "anonymous" },
        // No payment data for free tier
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
      // Return 402 with v2 payment requirements
      log.info("No payment header, returning 402", {
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

      // Add Bazaar discovery extension if metadata exists for this endpoint
      const endpointMetadata = getEndpointMetadata(c.req.path, c.req.method);
      if (endpointMetadata) {
        paymentRequired.extensions = {
          bazaar: buildBazaarExtension(endpointMetadata).bazaar,
        };
        log.debug("Added Bazaar extension to 402 response", { path: c.req.path });
      }

      // Set payment-required header (base64 encoded)
      c.header(X402_HEADERS.PAYMENT_REQUIRED, encodeBase64Json(paymentRequired));

      return c.json(paymentRequired, 402);
    }

    // Parse v2 payment payload from base64
    const paymentPayload = decodeBase64Json<PaymentPayloadV2>(paymentSignature);

    if (!paymentPayload || paymentPayload.x402Version !== 2) {
      log.error("Invalid payment payload", { paymentSignature: paymentSignature.substring(0, 50) });
      return c.json({
        error: "Invalid payment-signature header",
        code: X402_ERROR_CODES.INVALID_PAYLOAD,
        retryable: false,
        nextSteps: "Decode the payment-signature header as base64 JSON and ensure x402Version is 2",
      }, 400);
    }

    // Verify payment with settlement relay using v2 API
    const verifier = new X402PaymentVerifier(c.env.X402_FACILITATOR_URL);

    log.debug("Settling payment via settlement relay", {
      relayUrl: c.env.X402_FACILITATOR_URL,
      expectedRecipient: c.env.X402_SERVER_ADDRESS,
      minAmount: paymentRequirements.amount,
      asset,
      network: networkV2,
    });

    let settleResult: SettlementResponseV2;
    try {
      settleResult = await verifier.settle(paymentPayload, {
        paymentRequirements,
      });

      log.debug("Settle result", { ...settleResult });
    } catch (error) {
      const errorStr = String(error);
      log.error("Payment settlement exception", { error: errorStr });

      const classified = classifyPaymentError(error);
      if (classified.retryAfter) {
        c.header("Retry-After", String(classified.retryAfter));
      }

      return c.json(
        {
          error: classified.message,
          code: classified.code,
          retryable: classified.retryable,
          ...(classified.retryAfter !== undefined && { retryAfter: classified.retryAfter }),
          nextSteps: classified.nextSteps,
          asset,
          network: networkV2,
          resource: c.req.path,
          details: {
            exceptionMessage: errorStr,
          },
        },
        classified.httpStatus as 400 | 402 | 409 | 500 | 502 | 503
      );
    }

    if (!settleResult.success) {
      log.error("Payment settlement failed", { ...settleResult });

      const classified = classifyPaymentError(settleResult.errorReason || "settlement_failed", settleResult);

      if (classified.retryAfter) {
        c.header("Retry-After", String(classified.retryAfter));
      }

      return c.json(
        {
          error: classified.message,
          code: classified.code,
          retryable: classified.retryable,
          ...(classified.retryAfter !== undefined && { retryAfter: classified.retryAfter }),
          nextSteps: classified.nextSteps,
          asset,
          network: networkV2,
          resource: c.req.path,
          details: {
            errorReason: settleResult.errorReason,
          },
        },
        classified.httpStatus as 400 | 402 | 409 | 500 | 502 | 503
      );
    }

    // Extract payer address from settle result
    const payerAddress = settleResult.payer;

    if (!payerAddress) {
      log.error("Could not extract payer address from valid payment");
      return c.json(
        { error: "Could not identify payer from payment", code: X402_ERROR_CODES.SENDER_MISMATCH },
        500
      );
    }

    log.info("Payment verified successfully", {
      txId: settleResult.transaction,
      payerAddress,
      asset,
      network: networkV2,
      amount: paymentRequirements.amount,
      tier: dynamic ? "dynamic" : tier,
    });

    // Store payment context for downstream use
    c.set("x402", {
      payerAddress,
      settleResult,
      paymentPayload,
      paymentRequirements,
      priceEstimate,
      parsedBody,
    } as X402Context);

    // Add v2 response headers (base64 encoded)
    c.header(X402_HEADERS.PAYMENT_RESPONSE, encodeBase64Json(settleResult));
    c.header("X-PAYER-ADDRESS", payerAddress);

    return next();
  };
}

// No exported convenience functions - use x402Middleware directly
