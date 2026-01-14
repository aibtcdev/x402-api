/**
 * x402 Payment Middleware
 *
 * Verifies x402 payments for API requests using the x402-stacks library.
 * Supports both fixed tier pricing and dynamic pricing for LLM endpoints.
 */

import type { Context, MiddlewareHandler } from "hono";
import { X402PaymentVerifier } from "x402-stacks";
import type { TokenContract } from "x402-stacks";
import { deserializeTransaction } from "@stacks/transactions";
import type {
  Env,
  AppVariables,
  Logger,
  TokenType,
  PricingTier,
  PriceEstimate,
  SettlePaymentResult,
  X402Context,
  ChatCompletionRequest,
} from "../types";
import {
  validateTokenType,
  getFixedTierEstimate,
  estimateChatPayment,
  TIER_PRICING,
} from "../services/pricing";

// =============================================================================
// Types
// =============================================================================

export interface X402PaymentRequired {
  maxAmountRequired: string;
  resource: string;
  payTo: string;
  network: "mainnet" | "testnet";
  nonce: string;
  expiresAt: string;
  tokenType: TokenType;
  tokenContract?: TokenContract;
  pricing: {
    type: "fixed" | "dynamic";
    tier?: PricingTier;
    estimate?: {
      model?: string;
      estimatedInputTokens?: number;
      estimatedOutputTokens?: number;
      estimatedCostUsd?: string;
    };
  };
}

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
    USDCx: { address: "SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K", name: "token-susdc" },
  },
  testnet: {
    sBTC: { address: "ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT", name: "sbtc-token" },
    USDCx: { address: "ST1NXBK3K5YYMD6FD41MVNP3JS1GABZ8TRVX023PT", name: "token-susdc" },
  },
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Extract sender hash160 from a signed transaction
 */
function extractSenderFromTx(signedTxHex: string): string | null {
  try {
    const hex = signedTxHex.startsWith("0x") ? signedTxHex.slice(2) : signedTxHex;
    const tx = deserializeTransaction(hex);

    if (tx.auth?.spendingCondition) {
      const spendingCondition = tx.auth.spendingCondition as { signer?: string };
      return spendingCondition.signer || null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract payer address from settle result or signed tx
 */
function extractPayerAddress(
  settleResult: SettlePaymentResult,
  signedTxHex: string,
  network: "mainnet" | "testnet",
  log: Logger
): string | null {
  // Try settle result first (preferred - from facilitator)
  const fromResult =
    settleResult.senderAddress ||
    settleResult.sender_address ||
    settleResult.sender;

  if (fromResult) {
    log.debug("Payer address from settle result", { address: fromResult });
    return fromResult;
  }

  // Fallback: extract hash160 from signed transaction
  const hash160 = extractSenderFromTx(signedTxHex);
  if (hash160) {
    const identifier = `${network}:${hash160}`;
    log.debug("Payer identifier from tx deserialization (hash160)", { identifier, hash160 });
    return identifier;
  }

  log.warn("Could not extract payer address");
  return null;
}

/**
 * Safely serialize object with BigInt values converted to strings
 */
function safeStringify(obj: unknown): string {
  return JSON.stringify(obj, (_, value) =>
    typeof value === "bigint" ? value.toString() : value
  );
}

/**
 * Classify payment errors for appropriate response
 */
function classifyPaymentError(error: unknown, settleResult?: SettlePaymentResult): {
  code: string;
  message: string;
  httpStatus: number;
  retryAfter?: number;
} {
  const errorStr = String(error).toLowerCase();
  const resultError = settleResult?.error?.toLowerCase() || "";
  const resultReason = settleResult?.reason?.toLowerCase() || "";
  const validationError = settleResult?.validationError?.toLowerCase() || "";
  const combined = `${errorStr} ${resultError} ${resultReason} ${validationError}`;

  if (combined.includes("fetch") || combined.includes("network") || combined.includes("timeout")) {
    return { code: "NETWORK_ERROR", message: "Network error with payment facilitator", httpStatus: 502, retryAfter: 5 };
  }

  if (combined.includes("503") || combined.includes("unavailable")) {
    return { code: "FACILITATOR_UNAVAILABLE", message: "Payment facilitator temporarily unavailable", httpStatus: 503, retryAfter: 30 };
  }

  if (combined.includes("insufficient") || combined.includes("balance")) {
    return { code: "INSUFFICIENT_FUNDS", message: "Insufficient funds in wallet", httpStatus: 402 };
  }

  if (combined.includes("expired") || combined.includes("nonce")) {
    return { code: "PAYMENT_EXPIRED", message: "Payment expired, please sign a new payment", httpStatus: 402 };
  }

  if (combined.includes("amount") && (combined.includes("low") || combined.includes("minimum"))) {
    return { code: "AMOUNT_TOO_LOW", message: "Payment amount below minimum required", httpStatus: 402 };
  }

  if (combined.includes("invalid") || combined.includes("signature")) {
    return { code: "PAYMENT_INVALID", message: "Invalid payment signature", httpStatus: 400 };
  }

  return { code: "UNKNOWN_ERROR", message: "Payment processing error", httpStatus: 500, retryAfter: 5 };
}

// =============================================================================
// Middleware Factory
// =============================================================================

/**
 * Create x402 payment middleware
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
        priceEstimate = estimateChatPayment(parsedBody as ChatCompletionRequest, tokenType, log);
      }
    } else {
      // Fixed tier pricing
      priceEstimate = getFixedTierEstimate(tier, tokenType);
    }

    // Skip payment for free tier
    if (tier === "free" && !dynamic) {
      c.set("x402", {
        payerAddress: "anonymous",
        settleResult: { isValid: true },
        signedTx: "",
        priceEstimate,
        parsedBody,
      } as X402Context);
      return next();
    }

    const config = {
      minAmount: priceEstimate.amountInToken,
      address: c.env.X402_SERVER_ADDRESS,
      network: c.env.X402_NETWORK,
      facilitatorUrl: c.env.X402_FACILITATOR_URL,
    };

    // Check for payment header
    const signedTx = c.req.header("X-PAYMENT");

    if (!signedTx) {
      // Return 402 with payment requirements
      log.info("No payment header, returning 402", {
        tier: dynamic ? "dynamic" : tier,
        amountRequired: config.minAmount.toString(),
        tokenType,
      });

      // Get token contract for sBTC/USDCx
      let tokenContract: TokenContract | undefined;
      if (tokenType === "sBTC" || tokenType === "USDCx") {
        tokenContract = TOKEN_CONTRACTS[config.network][tokenType];
      }

      const paymentRequest: X402PaymentRequired = {
        maxAmountRequired: config.minAmount.toString(),
        resource: c.req.path,
        payTo: config.address,
        network: config.network,
        nonce: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        tokenType,
        ...(tokenContract && { tokenContract }),
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
      };

      return c.json(paymentRequest, 402);
    }

    // Verify payment with facilitator
    const verifier = new X402PaymentVerifier(config.facilitatorUrl, config.network);

    log.debug("Verifying payment", {
      facilitatorUrl: config.facilitatorUrl,
      expectedRecipient: config.address,
      minAmount: config.minAmount.toString(),
      tokenType,
    });

    let settleResult: SettlePaymentResult;
    try {
      settleResult = (await verifier.settlePayment(signedTx, {
        expectedRecipient: config.address,
        minAmount: config.minAmount,
        tokenType,
      })) as unknown as SettlePaymentResult;

      log.debug("Settle result", settleResult);
    } catch (error) {
      const errorStr = String(error);
      log.error("Payment verification exception", { error: errorStr });

      const classified = classifyPaymentError(error);
      if (classified.retryAfter) {
        c.header("Retry-After", String(classified.retryAfter));
      }

      return c.json(
        {
          error: classified.message,
          code: classified.code,
          tokenType,
          resource: c.req.path,
          details: {
            exceptionMessage: errorStr,
          },
        },
        classified.httpStatus as 400 | 402 | 500 | 502 | 503
      );
    }

    if (!settleResult.isValid) {
      log.error("Payment invalid", settleResult);

      const classified = classifyPaymentError(
        settleResult.validationError || settleResult.error || "invalid",
        settleResult
      );

      if (classified.retryAfter) {
        c.header("Retry-After", String(classified.retryAfter));
      }

      return c.json(
        {
          error: classified.message,
          code: classified.code,
          tokenType,
          resource: c.req.path,
          details: {
            settleError: settleResult.error,
            settleReason: settleResult.reason,
            validationError: settleResult.validationError,
          },
        },
        classified.httpStatus as 400 | 402 | 500 | 502 | 503
      );
    }

    // Extract payer address
    const payerAddress = extractPayerAddress(settleResult, signedTx, config.network, log);

    if (!payerAddress) {
      log.error("Could not extract payer address from valid payment");
      return c.json(
        { error: "Could not identify payer from payment", code: "PAYER_UNKNOWN" },
        500
      );
    }

    log.info("Payment verified successfully", {
      txId: settleResult.txId,
      payerAddress,
      tokenType,
      amount: config.minAmount.toString(),
      tier: dynamic ? "dynamic" : tier,
    });

    // Store payment context for downstream use
    c.set("x402", {
      payerAddress,
      settleResult,
      signedTx,
      priceEstimate,
      parsedBody,
    } as X402Context);

    // Add response headers (use safeStringify for BigInt compatibility)
    c.header("X-PAYMENT-RESPONSE", safeStringify(settleResult));
    c.header("X-PAYER-ADDRESS", payerAddress);

    return next();
  };
}

/**
 * Get x402 context from Hono context
 */
export function getX402Context(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
): X402Context | null {
  return c.var.x402 || null;
}

// =============================================================================
// Convenience Middleware Creators
// =============================================================================

/** Standard paid endpoints (0.001 STX) */
export const x402Standard = () => x402Middleware({ tier: "standard" });

/** Dynamic pricing for LLM endpoints (pass-through + 20%) */
export const x402Dynamic = () => x402Middleware({ dynamic: true });

