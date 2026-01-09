/**
 * Type definitions for x402 Stacks API Host
 */

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
  OPENROUTER_DO: DurableObjectNamespace;
  // Service bindings (typed as LogsRPC for RPC calls)
  LOGS: LogsRPC;
  // Secrets (set via wrangler secret put)
  OPENROUTER_API_KEY: string;
  // Environment variables
  ENVIRONMENT: string;
}

// =============================================================================
// Hono App Types
// =============================================================================

export interface AppVariables {
  requestId: string;
  logger: Logger;
}

// =============================================================================
// Usage Tracking Types
// =============================================================================

export interface UsageRecord {
  requestId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface DailyStats {
  date: string;
  totalRequests: number;
  totalTokens: number;
  totalCostUsd: number;
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

export interface StatsResponse {
  ok: boolean;
  data: DailyStats[];
}

export interface ErrorResponse {
  ok: false;
  error: string;
  requestId?: string;
}
