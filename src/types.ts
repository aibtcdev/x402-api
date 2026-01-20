/**
 * Type definitions for x402 API
 */

import type { Context } from "hono";
import type { UsageDO } from "./durable-objects/UsageDO";
import type { StorageDO } from "./durable-objects/StorageDO";
import type { MetricsDO } from "./durable-objects/MetricsDO";

// =============================================================================
// Logger Types (matching worker-logs RPC interface)
// =============================================================================

export interface LogsRPC {
  debug(appId: string, message: string, context?: Record<string, unknown>): Promise<unknown>;
  info(appId: string, message: string, context?: Record<string, unknown>): Promise<unknown>;
  warn(appId: string, message: string, context?: Record<string, unknown>): Promise<unknown>;
  error(appId: string, message: string, context?: Record<string, unknown>): Promise<unknown>;
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  child(additionalContext: Record<string, unknown>): Logger;
}

// =============================================================================
// Environment Types
// =============================================================================

export interface Env {
  // Durable Objects
  USAGE_DO: DurableObjectNamespace<UsageDO>;
  STORAGE_DO: DurableObjectNamespace<StorageDO>;
  METRICS_DO: DurableObjectNamespace<MetricsDO>;
  // KV Namespaces
  METRICS: KVNamespace;
  STORAGE: KVNamespace;
  // AI Binding
  AI: Ai;
  // Service bindings (optional - uncomment in wrangler.jsonc if available)
  LOGS?: LogsRPC;
  // Secrets (set via wrangler secret put)
  OPENROUTER_API_KEY: string;
  HIRO_API_KEY?: string;
  // Environment variables
  ENVIRONMENT: string;
  // x402 payment config
  X402_FACILITATOR_URL: string;
  X402_NETWORK: "mainnet" | "testnet";
  X402_SERVER_ADDRESS: string;
}

// =============================================================================
// Pricing Types
// =============================================================================

export type TokenType = "STX" | "sBTC" | "USDCx";

export type PricingTier = "free" | "standard" | "dynamic";

export interface PriceEstimate {
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  estimatedCostUsd: number;
  costWithMarginUsd: number;
  amountInToken: bigint;
  tokenType: TokenType;
  model?: string;
  tier?: PricingTier;
}

export interface TierPricing {
  stx: number;     // STX amount (e.g., 0.001)
  usd: number;     // USD equivalent for display
  description: string;
}

// =============================================================================
// x402 Context Types
// =============================================================================

/**
 * Token contract identifier for x402-stacks
 */
export interface TokenContract {
  address: string;
  name: string;
}

/**
 * 402 Payment Required response structure
 * Returned when a request needs payment
 */
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

export interface SettlePaymentResult {
  isValid: boolean;
  txId?: string;
  status?: string;
  blockHeight?: number;
  error?: string;
  reason?: string;
  validationError?: string;
  sender?: string;
  senderAddress?: string;
  sender_address?: string;
  recipient?: string;
  recipientAddress?: string;
  recipient_address?: string;
  [key: string]: unknown;
}

export interface X402Context {
  payerAddress: string;
  settleResult: SettlePaymentResult;
  signedTx: string;
  priceEstimate: PriceEstimate;
  parsedBody?: unknown;
}

// =============================================================================
// Hono App Types
// =============================================================================

export interface AppVariables {
  requestId: string;
  logger: Logger;
  x402?: X402Context;
  // Payment verification results (set by x402 middleware)
  settleResult?: SettlePaymentResult;
  signedTx?: string;
}

export type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

// =============================================================================
// Usage Tracking Types
// =============================================================================

export interface UsageRecord {
  requestId: string;
  endpoint: string;
  category: string;
  payerAddress: string;
  pricingType: "fixed" | "dynamic";
  tier?: PricingTier;
  amountCharged: number;  // microSTX
  token: TokenType;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}

export interface DailyStats {
  date: string;
  category: string;
  endpoint: string;
  totalRequests: number;
  totalRevenue: number;
  uniquePayers: number;
}

export interface AgentIdentity {
  agentId: string;
  createdAt: string;
}

// =============================================================================
// OpenRouter Types
// =============================================================================

export interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    name?: string;
    tool_calls?: unknown[];
    tool_call_id?: string;
  }>;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: { type: "text" | "json_object" };
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: unknown[];
    };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length: number;
  pricing: {
    prompt: string;
    completion: string;
    image?: string;
    request?: string;
  };
  top_provider?: {
    max_completion_tokens?: number;
    is_moderated?: boolean;
  };
  per_request_limits?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export interface ModelsResponse {
  data: OpenRouterModel[];
}

export interface UsageInfo {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

// =============================================================================
// Stacks Types
// =============================================================================

export interface StacksProfile {
  input: string;
  address: string;
  bnsName?: string;
  blockHeight: number;
  stxBalance: {
    balance: string;
    locked: string;
    unlockHeight?: number;
  };
  nonce: number;
  fungibleTokens: Array<{
    contractId: string;
    symbol?: string;
    balance: string;
    decimals?: number;
    usdValue?: number;
  }>;
  nonFungibleTokens: Array<{
    contractId: string;
    count: number;
  }>;
}

// =============================================================================
// Clarity Types (JSON-serializable)
// =============================================================================

export type ClarityArgument =
  | { type: "uint" | "int"; value: string }
  | { type: "bool"; value: boolean }
  | { type: "principal"; value: string }
  | { type: "string-ascii" | "string-utf8"; value: string }
  | { type: "buffer"; value: string }  // hex-encoded
  | { type: "none" }
  | { type: "some" | "ok" | "err"; value: ClarityArgument }
  | { type: "list"; value: ClarityArgument[] }
  | { type: "tuple"; value: Record<string, ClarityArgument> };
