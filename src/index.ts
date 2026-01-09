import { DurableObject } from "cloudflare:workers";
import type { Service } from "cloudflare:workers";

// LogsRPC interface (from worker-logs service)
interface LogsRPC {
  info(appId: string, message: string, context?: Record<string, unknown>): Promise<void>;
  warn(appId: string, message: string, context?: Record<string, unknown>): Promise<void>;
  error(appId: string, message: string, context?: Record<string, unknown>): Promise<void>;
  debug(appId: string, message: string, context?: Record<string, unknown>): Promise<void>;
}

export interface Env {
  // Durable Objects
  OPENROUTER_DO: DurableObjectNamespace<OpenRouterDO>;
  // Service bindings
  LOGS: Service<LogsRPC>;
  // Secrets (set via wrangler secret put)
  OPENROUTER_API_KEY: string;
  // Environment variables
  ENVIRONMENT: string;
}

const APP_ID = "x402-api-host";

/**
 * OpenRouter Durable Object
 * Handles per-user/agent state for OpenRouter API access:
 * - Usage tracking (tokens, cost)
 * - Rate limiting
 * - Request history
 */
export class OpenRouterDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.initSchema();
  }

  private initSchema(): void {
    this.sql.exec(`
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
    `);
  }

  /**
   * Record usage for a request
   */
  async recordUsage(data: {
    requestId: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
  }): Promise<void> {
    const today = new Date().toISOString().split("T")[0];

    this.sql.exec(
      `INSERT INTO usage (request_id, model, prompt_tokens, completion_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?)`,
      data.requestId,
      data.model,
      data.promptTokens,
      data.completionTokens,
      data.costUsd
    );

    // Update daily stats
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
  }

  /**
   * Get usage stats for the agent
   */
  async getStats(days: number = 7): Promise<unknown[]> {
    const result = this.sql.exec(
      `SELECT * FROM daily_stats
       ORDER BY date DESC
       LIMIT ?`,
      days
    );
    return result.toArray();
  }

  /**
   * Handle HTTP requests to the DO
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/stats") {
      const stats = await this.getStats();
      return Response.json({ ok: true, data: stats });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }
}

/**
 * Main worker entry point
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();

    // Health check
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        environment: env.ENVIRONMENT,
        services: ["openrouter"],
      });
    }

    // OpenRouter proxy endpoints
    if (url.pathname.startsWith("/v1/")) {
      // Log incoming request
      ctx.waitUntil(
        env.LOGS.info(APP_ID, "API request received", {
          request_id: requestId,
          path: url.pathname,
          method: request.method,
        })
      );

      // TODO: Implement x402 payment verification
      // TODO: Proxy to OpenRouter with our API key
      // TODO: Record usage in DO

      return Response.json(
        { error: "Not implemented", request_id: requestId },
        { status: 501 }
      );
    }

    // Usage stats endpoint (requires auth)
    if (url.pathname === "/usage") {
      // TODO: Authenticate agent
      // TODO: Get agent's DO and return stats
      return Response.json({ error: "Not implemented" }, { status: 501 });
    }

    return new Response("x402 Stacks API Host", {
      headers: { "Content-Type": "text/plain" },
    });
  },
};
