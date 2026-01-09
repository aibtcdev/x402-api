/**
 * x402 Stacks API Host
 *
 * Cloudflare Worker exposing third-party APIs on a pay-per-use basis
 * using the x402 protocol.
 *
 * Architecture follows Cloudflare best practices (Dec 2025):
 * - SQLite-backed Durable Objects with RPC methods
 * - blockConcurrencyWhile() for schema initialization
 * - Hono for HTTP routing
 * - worker-logs integration for centralized logging
 */

import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { loggerMiddleware, getLogger } from "./utils/logger";
import type {
  Env,
  AppVariables,
  UsageRecord,
  DailyStats,
  AgentIdentity,
  HealthResponse,
  StatsResponse,
} from "./types";

// =============================================================================
// OpenRouter Durable Object
// =============================================================================

/**
 * OpenRouter Durable Object
 *
 * Per-agent state for OpenRouter API access:
 * - Usage tracking (tokens, cost per request)
 * - Daily stats aggregation
 * - Rate limiting (TODO)
 *
 * Design follows Cloudflare "Rules of Durable Objects" (Dec 2025):
 * - One DO per agent (not a global singleton)
 * - SQLite storage (recommended over KV)
 * - RPC methods (not fetch handler)
 * - blockConcurrencyWhile() for initialization
 */
export class OpenRouterDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    // Use blockConcurrencyWhile to prevent race conditions during schema init
    // This ensures no requests are processed until schema is ready
    ctx.blockConcurrencyWhile(async () => {
      this.initSchema();
    });
  }

  /**
   * Initialize database schema
   * Called in constructor via blockConcurrencyWhile
   */
  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS identity (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        timestamp TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS daily_stats (
        date TEXT PRIMARY KEY,
        total_requests INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        total_cost_usd REAL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage(timestamp);
      CREATE INDEX IF NOT EXISTS idx_usage_request_id ON usage(request_id);
    `);
  }

  // ===========================================================================
  // Identity Management (RPC methods)
  // ===========================================================================

  /**
   * Initialize the DO with an agent ID
   * Called once when first routing to this DO
   * DOs don't know their own name/ID, so we store it explicitly
   */
  async init(agentId: string): Promise<AgentIdentity> {
    try {
      const existing = this.sql
        .exec("SELECT value FROM identity WHERE key = 'agent_id'")
        .toArray();

      if (existing.length > 0) {
        const createdAt = this.sql
          .exec("SELECT value FROM identity WHERE key = 'created_at'")
          .toArray();
        return {
          agentId: existing[0].value as string,
          createdAt: createdAt[0]?.value as string,
        };
      }

      const now = new Date().toISOString();
      this.sql.exec(
        "INSERT INTO identity (key, value) VALUES ('agent_id', ?)",
        agentId
      );
      this.sql.exec(
        "INSERT INTO identity (key, value) VALUES ('created_at', ?)",
        now
      );

      return { agentId, createdAt: now };
    } catch (error) {
      console.error("[OpenRouterDO] Failed to init identity:", error);
      throw error;
    }
  }

  /**
   * Get the agent's identity
   */
  async getIdentity(): Promise<AgentIdentity | null> {
    try {
      const agentId = this.sql
        .exec("SELECT value FROM identity WHERE key = 'agent_id'")
        .toArray();

      if (agentId.length === 0) {
        return null;
      }

      const createdAt = this.sql
        .exec("SELECT value FROM identity WHERE key = 'created_at'")
        .toArray();

      return {
        agentId: agentId[0].value as string,
        createdAt: createdAt[0]?.value as string,
      };
    } catch (error) {
      console.error("[OpenRouterDO] Failed to get identity:", error);
      throw error;
    }
  }

  // ===========================================================================
  // Usage Tracking (RPC methods)
  // ===========================================================================

  /**
   * Record usage for a request
   */
  async recordUsage(data: UsageRecord): Promise<void> {
    try {
      const today = new Date().toISOString().split("T")[0];

      // Insert usage record
      this.sql.exec(
        `INSERT INTO usage (request_id, model, prompt_tokens, completion_tokens, cost_usd)
         VALUES (?, ?, ?, ?, ?)`,
        data.requestId,
        data.model,
        data.promptTokens,
        data.completionTokens,
        data.costUsd
      );

      // Update daily stats (atomic via write coalescing)
      this.sql.exec(
        `INSERT INTO daily_stats (date, total_requests, total_tokens, total_cost_usd)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(date) DO UPDATE SET
           total_requests = total_requests + 1,
           total_tokens = total_tokens + excluded.total_tokens,
           total_cost_usd = total_cost_usd + excluded.total_cost_usd`,
        today,
        data.promptTokens + data.completionTokens,
        data.costUsd
      );
    } catch (error) {
      console.error("[OpenRouterDO] Failed to record usage:", error);
      throw error;
    }
  }

  /**
   * Get usage stats for the agent
   */
  async getStats(days: number = 7): Promise<DailyStats[]> {
    try {
      const result = this.sql.exec(
        `SELECT date, total_requests, total_tokens, total_cost_usd
         FROM daily_stats
         ORDER BY date DESC
         LIMIT ?`,
        days
      );

      return result.toArray().map((row) => ({
        date: row.date as string,
        totalRequests: row.total_requests as number,
        totalTokens: row.total_tokens as number,
        totalCostUsd: row.total_cost_usd as number,
      }));
    } catch (error) {
      console.error("[OpenRouterDO] Failed to get stats:", error);
      throw error;
    }
  }

  /**
   * Get total usage across all time
   */
  async getTotalUsage(): Promise<{
    totalRequests: number;
    totalTokens: number;
    totalCostUsd: number;
  }> {
    try {
      const result = this.sql
        .exec(
          `SELECT
            COALESCE(SUM(total_requests), 0) as total_requests,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(total_cost_usd), 0) as total_cost_usd
           FROM daily_stats`
        )
        .toArray();

      const row = result[0];
      return {
        totalRequests: row?.total_requests as number ?? 0,
        totalTokens: row?.total_tokens as number ?? 0,
        totalCostUsd: row?.total_cost_usd as number ?? 0,
      };
    } catch (error) {
      console.error("[OpenRouterDO] Failed to get total usage:", error);
      throw error;
    }
  }

  /**
   * Get recent usage records
   */
  async getRecentUsage(limit: number = 10): Promise<
    Array<{
      requestId: string;
      model: string;
      promptTokens: number;
      completionTokens: number;
      costUsd: number;
      timestamp: string;
    }>
  > {
    try {
      const result = this.sql.exec(
        `SELECT request_id, model, prompt_tokens, completion_tokens, cost_usd, timestamp
         FROM usage
         ORDER BY timestamp DESC
         LIMIT ?`,
        limit
      );

      return result.toArray().map((row) => ({
        requestId: row.request_id as string,
        model: row.model as string,
        promptTokens: row.prompt_tokens as number,
        completionTokens: row.completion_tokens as number,
        costUsd: row.cost_usd as number,
        timestamp: row.timestamp as string,
      }));
    } catch (error) {
      console.error("[OpenRouterDO] Failed to get recent usage:", error);
      throw error;
    }
  }
}

// =============================================================================
// Hono App
// =============================================================================

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// CORS middleware
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["X-PAYMENT", "X-PAYMENT-TOKEN-TYPE", "Authorization"],
  })
);

// Logger middleware - creates logger with CF-Ray ID
app.use("*", loggerMiddleware);

// =============================================================================
// Health & Info Endpoints
// =============================================================================

app.get("/", (c) => {
  return c.json({
    service: "x402-api-host",
    version: "0.1.0",
    description: "x402 micropayment-gated API proxy for OpenRouter",
    endpoints: {
      "GET /health": "Health check",
      "POST /v1/chat/completions": "OpenRouter proxy (x402 paid)",
      "GET /v1/models": "List available models",
      "GET /usage": "Get usage stats (requires auth)",
    },
  });
});

app.get("/health", (c) => {
  const log = getLogger(c);
  log.debug("Health check requested");

  const response: HealthResponse = {
    status: "ok",
    environment: c.env.ENVIRONMENT,
    services: ["openrouter"],
  };

  return c.json(response);
});

// =============================================================================
// OpenRouter Proxy Endpoints
// =============================================================================

app.post("/v1/chat/completions", async (c) => {
  const log = getLogger(c);
  const requestId = c.get("requestId");

  log.info("Chat completion request received", {
    method: c.req.method,
  });

  try {
    // TODO: Implement x402 payment verification
    // TODO: Proxy to OpenRouter with our API key
    // TODO: Record usage in DO

    return c.json(
      { error: "Not implemented", request_id: requestId },
      { status: 501 }
    );
  } catch (error) {
    log.error("Chat completion failed", {
      error: error instanceof Error ? error.message : String(error),
    });

    return c.json(
      {
        ok: false,
        error: "Internal server error",
        requestId,
      },
      { status: 500 }
    );
  }
});

app.get("/v1/models", async (c) => {
  const log = getLogger(c);

  log.debug("Models list requested");

  try {
    // TODO: Fetch and cache models from OpenRouter
    return c.json({ error: "Not implemented" }, { status: 501 });
  } catch (error) {
    log.error("Failed to fetch models", {
      error: error instanceof Error ? error.message : String(error),
    });

    return c.json(
      { ok: false, error: "Internal server error" },
      { status: 500 }
    );
  }
});

// =============================================================================
// Usage Stats Endpoint
// =============================================================================

app.get("/usage", async (c) => {
  const log = getLogger(c);

  log.debug("Usage stats requested");

  try {
    // TODO: Authenticate agent and get their DO
    // For now, return not implemented
    return c.json({ error: "Not implemented" }, { status: 501 });
  } catch (error) {
    log.error("Failed to get usage stats", {
      error: error instanceof Error ? error.message : String(error),
    });

    return c.json(
      { ok: false, error: "Internal server error" },
      { status: 500 }
    );
  }
});

// =============================================================================
// Error Handler
// =============================================================================

app.onError((err, c) => {
  const log = getLogger(c);
  const requestId = c.get("requestId") || "unknown";

  log.error("Unhandled error", {
    error: err.message,
    stack: err.stack,
  });

  return c.json(
    {
      ok: false,
      error: "Internal server error",
      requestId,
    },
    { status: 500 }
  );
});

// =============================================================================
// 404 Handler
// =============================================================================

app.notFound((c) => {
  const log = getLogger(c);
  log.warn("Route not found", { path: c.req.path });

  return c.json(
    {
      ok: false,
      error: "Not found",
      path: c.req.path,
    },
    { status: 404 }
  );
});

// =============================================================================
// Export
// =============================================================================

export default app;
