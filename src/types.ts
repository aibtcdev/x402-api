/**
 * Type definitions for x402 API
 */

import type { Context } from "hono";
import type { UsageDO } from "./durable-objects/UsageDO";
import type { StorageDO } from "./durable-objects/StorageDO";

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

export type PricingTier =
  | "free"
  | "simple"
  | "ai"
  | "heavy_ai"
  | "storage_read"
  | "storage_write"
  | "storage_write_large"
  | "dynamic";

export interface PricingConfig {
  tier: PricingTier;
  /** Only for dynamic pricing - function to estimate cost */
  estimator?: (body: unknown) => PriceEstimate;
}

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
// API Response Types
// =============================================================================

export interface HealthResponse {
  status: "ok" | "error";
  environment: string;
  services: string[];
}

export interface ErrorResponse {
  ok: false;
  error: string;
  requestId?: string;
  code?: string;
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
