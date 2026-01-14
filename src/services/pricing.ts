/**
 * Pricing Service
 *
 * Central pricing configuration for all endpoints.
 * Supports both fixed tiers and dynamic pricing for LLM endpoints.
 */

import { STXtoMicroSTX, BTCtoSats, USDCxToMicroUSDCx } from "x402-stacks";
import type {
  TokenType,
  PricingTier,
  PriceEstimate,
  TierPricing,
  ChatCompletionRequest,
  Logger,
} from "../types";

// =============================================================================
// Constants
// =============================================================================

/** Margin added to OpenRouter costs (20% as decided) */
export const COST_MARGIN = 0.20;

/** Buffer for output tokens when estimating (assume 2x input for safety) */
const OUTPUT_TOKEN_MULTIPLIER = 2;

/** Minimum payment in USD (floor for very small requests) */
const MIN_PAYMENT_USD = 0.001;

/** Approximate tokens per character (conservative estimate) */
const TOKENS_PER_CHAR = 0.25;

// =============================================================================
// Fixed Tier Pricing
// =============================================================================

/**
 * Fixed pricing tiers in STX
 * Simplified: free, standard (0.001 STX), dynamic (LLM pass-through + 20%)
 */
export const TIER_PRICING: Record<PricingTier, TierPricing> = {
  free: {
    stx: 0,
    usd: 0,
    description: "Free endpoint",
  },
  standard: {
    stx: 0.001,
    usd: 0.0005,
    description: "Standard paid endpoint",
  },
  dynamic: {
    stx: 0,
    usd: 0,
    description: "Dynamic pricing (LLM pass-through + 20%)",
  },
};

// =============================================================================
// Model Pricing (for dynamic LLM pricing)
// =============================================================================

export interface ModelPricing {
  promptPer1k: number;      // USD per 1K prompt tokens
  completionPer1k: number;  // USD per 1K completion tokens
}

/**
 * Model pricing in USD per 1K tokens
 * Based on OpenRouter pricing - updated periodically
 * https://openrouter.ai/docs/models
 */
const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI models
  "openai/gpt-4o": { promptPer1k: 0.0025, completionPer1k: 0.01 },
  "openai/gpt-4o-mini": { promptPer1k: 0.00015, completionPer1k: 0.0006 },
  "openai/gpt-4-turbo": { promptPer1k: 0.01, completionPer1k: 0.03 },
  "openai/gpt-3.5-turbo": { promptPer1k: 0.0005, completionPer1k: 0.0015 },

  // Anthropic models
  "anthropic/claude-3.5-sonnet": { promptPer1k: 0.003, completionPer1k: 0.015 },
  "anthropic/claude-3-opus": { promptPer1k: 0.015, completionPer1k: 0.075 },
  "anthropic/claude-3-haiku": { promptPer1k: 0.00025, completionPer1k: 0.00125 },
  "anthropic/claude-instant-1.2": { promptPer1k: 0.0008, completionPer1k: 0.0024 },

  // Google models
  "google/gemini-pro": { promptPer1k: 0.000125, completionPer1k: 0.000375 },
  "google/gemini-pro-1.5": { promptPer1k: 0.00125, completionPer1k: 0.005 },

  // Meta models
  "meta-llama/llama-3.1-70b-instruct": { promptPer1k: 0.00035, completionPer1k: 0.0004 },
  "meta-llama/llama-3.1-8b-instruct": { promptPer1k: 0.00005, completionPer1k: 0.00005 },

  // Mistral models
  "mistralai/mistral-7b-instruct": { promptPer1k: 0.00006, completionPer1k: 0.00006 },
  "mistralai/mixtral-8x7b-instruct": { promptPer1k: 0.00024, completionPer1k: 0.00024 },
};

/** Default pricing for unknown models (conservative/high estimate) */
const DEFAULT_MODEL_PRICING: ModelPricing = {
  promptPer1k: 0.01,
  completionPer1k: 0.03,
};

// =============================================================================
// Token Exchange Rates
// =============================================================================

/**
 * Token exchange rates (approximate, for converting USD to tokens)
 * Updated periodically based on market rates
 */
const TOKEN_RATES: Record<TokenType, number> = {
  STX: 0.50,      // 1 STX ≈ $0.50 USD
  sBTC: 100000,   // 1 sBTC ≈ $100,000 USD
  USDCx: 1.0,     // 1 USDCx = $1 USD (Circle USDC via xReserve)
};

// =============================================================================
// Public Functions
// =============================================================================

/**
 * Get pricing for a model
 */
export function getModelPricing(model: string): ModelPricing {
  // Try exact match
  if (MODEL_PRICING[model]) {
    return MODEL_PRICING[model];
  }

  // Try prefix match (e.g., "openai/gpt-4o-2024-08-06" matches "openai/gpt-4o")
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(key)) {
      return pricing;
    }
  }

  // Try category match based on model name patterns
  const modelLower = model.toLowerCase();

  if (modelLower.includes("gpt-4o-mini") || modelLower.includes("haiku")) {
    return { promptPer1k: 0.00015, completionPer1k: 0.0006 };
  }
  if (modelLower.includes("gpt-4o") || modelLower.includes("sonnet")) {
    return { promptPer1k: 0.003, completionPer1k: 0.015 };
  }
  if (modelLower.includes("gpt-4") || modelLower.includes("opus")) {
    return { promptPer1k: 0.01, completionPer1k: 0.03 };
  }
  if (modelLower.includes("gpt-3.5") || modelLower.includes("instant")) {
    return { promptPer1k: 0.0005, completionPer1k: 0.0015 };
  }
  if (modelLower.includes("llama") || modelLower.includes("mistral")) {
    return { promptPer1k: 0.0002, completionPer1k: 0.0002 };
  }

  return DEFAULT_MODEL_PRICING;
}

/**
 * Estimate token count from messages
 */
export function estimateInputTokens(messages: ChatCompletionRequest["messages"]): number {
  let totalChars = 0;

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      totalChars += msg.content.length;
    }
    // Add overhead for role, formatting
    totalChars += 10;
  }

  // Convert chars to tokens (conservative estimate)
  return Math.ceil(totalChars * TOKENS_PER_CHAR);
}

/**
 * Minimum amounts in base units (to avoid sub-unit truncation to 0)
 * These represent ~$0.001 USD floor to ensure payment is non-zero
 */
const MIN_TOKEN_AMOUNTS: Record<TokenType, bigint> = {
  STX: BigInt(1000),    // 0.001 STX (1000 microSTX)
  sBTC: BigInt(1),      // 1 satoshi (~$0.001 at $100k BTC)
  USDCx: BigInt(1000),  // 0.001 USDCx (1000 microUSDCx)
};

/**
 * Convert USD to token amount
 */
export function usdToTokenAmount(usd: number, tokenType: TokenType): bigint {
  const rate = TOKEN_RATES[tokenType];
  const tokenAmount = usd / rate;

  let result: bigint;
  switch (tokenType) {
    case "STX":
      result = STXtoMicroSTX(tokenAmount.toFixed(6));
      break;
    case "sBTC":
      result = BTCtoSats(tokenAmount);
      break;
    case "USDCx":
      result = USDCxToMicroUSDCx(tokenAmount);
      break;
    default:
      throw new Error(`Unknown token type: ${tokenType}`);
  }

  // Ensure minimum amount (avoid truncation to 0)
  const minAmount = MIN_TOKEN_AMOUNTS[tokenType];
  if (result < minAmount) {
    return minAmount;
  }
  return result;
}

/**
 * Convert STX amount to token amount (for fixed tiers)
 */
export function stxToTokenAmount(stx: number, tokenType: TokenType): bigint {
  // Convert STX to USD first, then to target token
  const usd = stx * TOKEN_RATES.STX;
  return usdToTokenAmount(usd, tokenType);
}

/**
 * Get price estimate for a fixed tier
 */
export function getFixedTierEstimate(tier: PricingTier, tokenType: TokenType): PriceEstimate {
  const tierPricing = TIER_PRICING[tier];

  // For free tier, return zero
  if (tier === "free") {
    return {
      estimatedCostUsd: 0,
      costWithMarginUsd: 0,
      amountInToken: BigInt(0),
      tokenType,
      tier,
    };
  }

  const stxAmount = tierPricing.stx;
  const amountInToken = stxToTokenAmount(stxAmount, tokenType);

  return {
    estimatedCostUsd: tierPricing.usd,
    costWithMarginUsd: tierPricing.usd,
    amountInToken,
    tokenType,
    tier,
  };
}

/**
 * Estimate payment amount for a chat completion request (dynamic pricing)
 */
export function estimateChatPayment(
  request: ChatCompletionRequest,
  tokenType: TokenType,
  log?: Logger
): PriceEstimate {
  const pricing = getModelPricing(request.model);
  const estimatedInputTokens = estimateInputTokens(request.messages);

  // Estimate output tokens (use max_tokens if provided, otherwise estimate)
  const estimatedOutputTokens = request.max_tokens
    ? Math.min(request.max_tokens, estimatedInputTokens * OUTPUT_TOKEN_MULTIPLIER)
    : estimatedInputTokens * OUTPUT_TOKEN_MULTIPLIER;

  // Calculate cost in USD
  const promptCost = (estimatedInputTokens / 1000) * pricing.promptPer1k;
  const completionCost = (estimatedOutputTokens / 1000) * pricing.completionPer1k;
  const estimatedCostUsd = promptCost + completionCost;

  // Apply margin and minimum
  const costWithMarginUsd = Math.max(
    estimatedCostUsd * (1 + COST_MARGIN),
    MIN_PAYMENT_USD
  );

  // Convert to token amount
  const amountInToken = usdToTokenAmount(costWithMarginUsd, tokenType);

  const estimate: PriceEstimate = {
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedCostUsd,
    costWithMarginUsd,
    amountInToken,
    tokenType,
    model: request.model,
    tier: "dynamic",
  };

  if (log) {
    log.debug("Price estimate calculated", {
      model: request.model,
      inputTokens: estimatedInputTokens,
      outputTokens: estimatedOutputTokens,
      promptPer1k: pricing.promptPer1k,
      completionPer1k: pricing.completionPer1k,
      estimatedCostUsd: estimatedCostUsd.toFixed(6),
      costWithMarginUsd: costWithMarginUsd.toFixed(6),
      tokenType,
      amountInToken: amountInToken.toString(),
    });
  }

  return estimate;
}

/**
 * Log actual vs estimated cost for PnL tracking
 */
export function logPnL(
  estimate: PriceEstimate,
  actualCostUsd: number,
  actualInputTokens: number,
  actualOutputTokens: number,
  log: Logger
): void {
  const estimateError = ((estimate.estimatedCostUsd - actualCostUsd) / actualCostUsd) * 100;
  const profit = estimate.costWithMarginUsd - actualCostUsd;

  log.info("PnL tracking", {
    model: estimate.model,
    // Estimated
    estimatedInputTokens: estimate.estimatedInputTokens,
    estimatedOutputTokens: estimate.estimatedOutputTokens,
    estimatedCostUsd: estimate.estimatedCostUsd.toFixed(6),
    // Actual
    actualInputTokens,
    actualOutputTokens,
    actualCostUsd: actualCostUsd.toFixed(6),
    // Analysis
    estimateErrorPct: estimateError.toFixed(1),
    chargedUsd: estimate.costWithMarginUsd.toFixed(6),
    profitUsd: profit.toFixed(6),
    profitPct: ((profit / actualCostUsd) * 100).toFixed(1),
  });
}

/**
 * Validate token type string and return typed value
 */
export function validateTokenType(tokenTypeStr: string): TokenType {
  const upper = tokenTypeStr.toUpperCase();
  const validMap: Record<string, TokenType> = {
    STX: "STX",
    SBTC: "sBTC",
    USDCX: "USDCx",
    USDC: "USDCx", // Alias USDC to USDCx for convenience
  };

  if (validMap[upper]) {
    return validMap[upper];
  }

  throw new Error(`Invalid tokenType: ${tokenTypeStr}. Supported: STX, sBTC, USDCx`);
}

/**
 * Estimate cost from actual usage (for cost tracking after completion)
 */
export function estimateActualCost(
  promptTokens: number,
  completionTokens: number,
  model: string
): number {
  const pricing = getModelPricing(model);
  const promptCost = (promptTokens / 1000) * pricing.promptPer1k;
  const completionCost = (completionTokens / 1000) * pricing.completionPer1k;
  return promptCost + completionCost;
}
