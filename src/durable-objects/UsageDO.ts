/**
 * UsageDO - Per-payer Usage Tracking Durable Object
 *
 * Tracks usage per payer address for dashboard and analytics.
 * SQLite-backed for efficient querying and aggregation.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env, UsageRecord, DailyStats, PricingTier, TokenType } from "../types";

export class UsageDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    // Initialize schema using blockConcurrencyWhile for safety
    ctx.blockConcurrencyWhile(async () => {
      this.initSchema();
    });
  }

  /**
   * Initialize database schema
   */
  private initSchema(): void {
    this.sql.exec(`
      -- Identity table (store payer address since DO doesn't know its own name)
      CREATE TABLE IF NOT EXISTS identity (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Per-request usage records
      CREATE TABLE IF NOT EXISTS usage (
        request_id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        category TEXT NOT NULL,
        payer_address TEXT NOT NULL,
        pricing_type TEXT NOT NULL,
        tier TEXT,
        amount_charged INTEGER NOT NULL,
        token TEXT NOT NULL,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        timestamp INTEGER NOT NULL,
        duration_ms INTEGER
      );

      -- Daily aggregates for dashboard
      CREATE TABLE IF NOT EXISTS daily_stats (
        date TEXT NOT NULL,
        category TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        total_requests INTEGER DEFAULT 0,
        total_revenue INTEGER DEFAULT 0,
        PRIMARY KEY (date, category, endpoint)
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage(timestamp);
      CREATE INDEX IF NOT EXISTS idx_usage_category ON usage(category);
      CREATE INDEX IF NOT EXISTS idx_usage_endpoint ON usage(endpoint);
      CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date);
    `);
  }

  // ===========================================================================
  // Identity Management
  // ===========================================================================

  /**
   * Initialize the DO with a payer address
   */
  async init(payerAddress: string): Promise<{ payerAddress: string; createdAt: string }> {
    const existing = this.sql
      .exec("SELECT value FROM identity WHERE key = 'payer_address'")
      .toArray();

    if (existing.length > 0) {
      const createdAt = this.sql
        .exec("SELECT value FROM identity WHERE key = 'created_at'")
        .toArray();
      return {
        payerAddress: existing[0].value as string,
        createdAt: createdAt[0]?.value as string,
      };
    }

    const now = new Date().toISOString();
    this.sql.exec(
      "INSERT INTO identity (key, value) VALUES ('payer_address', ?)",
      payerAddress
    );
    this.sql.exec(
      "INSERT INTO identity (key, value) VALUES ('created_at', ?)",
      now
    );

    return { payerAddress, createdAt: now };
  }

  /**
   * Get the payer's identity
   */
  async getIdentity(): Promise<{ payerAddress: string; createdAt: string } | null> {
    const address = this.sql
      .exec("SELECT value FROM identity WHERE key = 'payer_address'")
      .toArray();

    if (address.length === 0) {
      return null;
    }

    const createdAt = this.sql
      .exec("SELECT value FROM identity WHERE key = 'created_at'")
      .toArray();

    return {
      payerAddress: address[0].value as string,
      createdAt: createdAt[0]?.value as string,
    };
  }

  // ===========================================================================
  // Usage Recording
  // ===========================================================================

  /**
   * Record usage for a request
   */
  async recordUsage(record: UsageRecord): Promise<void> {
    const timestamp = Date.now();
    const today = new Date().toISOString().split("T")[0];

    // Insert usage record
    this.sql.exec(
      `INSERT INTO usage (
        request_id, endpoint, category, payer_address, pricing_type,
        tier, amount_charged, token, model, input_tokens, output_tokens,
        timestamp, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.requestId,
      record.endpoint,
      record.category,
      record.payerAddress,
      record.pricingType,
      record.tier || null,
      record.amountCharged,
      record.token,
      record.model || null,
      record.inputTokens || null,
      record.outputTokens || null,
      timestamp,
      record.durationMs || null
    );

    // Update daily stats
    this.sql.exec(
      `INSERT INTO daily_stats (date, category, endpoint, total_requests, total_revenue)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(date, category, endpoint) DO UPDATE SET
         total_requests = total_requests + 1,
         total_revenue = total_revenue + excluded.total_revenue`,
      today,
      record.category,
      record.endpoint,
      record.amountCharged
    );
  }

  // ===========================================================================
  // Statistics Queries
  // ===========================================================================

  /**
   * Get daily stats for the last N days
   */
  async getDailyStats(days: number = 30): Promise<DailyStats[]> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const results = this.sql
      .exec(
        `SELECT date, category, endpoint, total_requests, total_revenue
         FROM daily_stats
         WHERE date >= ?
         ORDER BY date DESC, category, endpoint`,
        cutoff
      )
      .toArray();

    return results.map((row) => ({
      date: row.date as string,
      category: row.category as string,
      endpoint: row.endpoint as string,
      totalRequests: row.total_requests as number,
      totalRevenue: row.total_revenue as number,
      uniquePayers: 1, // This DO is per-payer, so always 1
    }));
  }

  /**
   * Get total usage across all time
   */
  async getTotalUsage(): Promise<{
    totalRequests: number;
    totalRevenue: number;
    totalTokens: number;
    firstRequest: string | null;
    lastRequest: string | null;
  }> {
    const statsResult = this.sql
      .exec(
        `SELECT
          COUNT(*) as total_requests,
          COALESCE(SUM(amount_charged), 0) as total_revenue,
          COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) as total_tokens
         FROM usage`
      )
      .toArray();

    const firstResult = this.sql
      .exec("SELECT MIN(timestamp) as first_ts FROM usage")
      .toArray();

    const lastResult = this.sql
      .exec("SELECT MAX(timestamp) as last_ts FROM usage")
      .toArray();

    const stats = statsResult[0];
    const firstTs = firstResult[0]?.first_ts as number | null;
    const lastTs = lastResult[0]?.last_ts as number | null;

    return {
      totalRequests: (stats?.total_requests as number) ?? 0,
      totalRevenue: (stats?.total_revenue as number) ?? 0,
      totalTokens: (stats?.total_tokens as number) ?? 0,
      firstRequest: firstTs ? new Date(firstTs).toISOString() : null,
      lastRequest: lastTs ? new Date(lastTs).toISOString() : null,
    };
  }

  /**
   * Get usage by category
   */
  async getUsageByCategory(): Promise<
    Array<{
      category: string;
      totalRequests: number;
      totalRevenue: number;
    }>
  > {
    const results = this.sql
      .exec(
        `SELECT category, COUNT(*) as total_requests, SUM(amount_charged) as total_revenue
         FROM usage
         GROUP BY category
         ORDER BY total_revenue DESC`
      )
      .toArray();

    return results.map((row) => ({
      category: row.category as string,
      totalRequests: row.total_requests as number,
      totalRevenue: row.total_revenue as number,
    }));
  }

  /**
   * Get usage by endpoint
   */
  async getUsageByEndpoint(limit: number = 20): Promise<
    Array<{
      endpoint: string;
      category: string;
      totalRequests: number;
      totalRevenue: number;
    }>
  > {
    const results = this.sql
      .exec(
        `SELECT endpoint, category, COUNT(*) as total_requests, SUM(amount_charged) as total_revenue
         FROM usage
         GROUP BY endpoint, category
         ORDER BY total_requests DESC
         LIMIT ?`,
        limit
      )
      .toArray();

    return results.map((row) => ({
      endpoint: row.endpoint as string,
      category: row.category as string,
      totalRequests: row.total_requests as number,
      totalRevenue: row.total_revenue as number,
    }));
  }

  /**
   * Get recent usage records
   */
  async getRecentUsage(limit: number = 20): Promise<
    Array<{
      requestId: string;
      endpoint: string;
      category: string;
      pricingType: string;
      tier: string | null;
      amountCharged: number;
      token: string;
      model: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
      timestamp: string;
      durationMs: number | null;
    }>
  > {
    const results = this.sql
      .exec(
        `SELECT request_id, endpoint, category, pricing_type, tier, amount_charged,
                token, model, input_tokens, output_tokens, timestamp, duration_ms
         FROM usage
         ORDER BY timestamp DESC
         LIMIT ?`,
        limit
      )
      .toArray();

    return results.map((row) => ({
      requestId: row.request_id as string,
      endpoint: row.endpoint as string,
      category: row.category as string,
      pricingType: row.pricing_type as string,
      tier: row.tier as string | null,
      amountCharged: row.amount_charged as number,
      token: row.token as string,
      model: row.model as string | null,
      inputTokens: row.input_tokens as number | null,
      outputTokens: row.output_tokens as number | null,
      timestamp: new Date(row.timestamp as number).toISOString(),
      durationMs: row.duration_ms as number | null,
    }));
  }

  /**
   * Get model usage breakdown (for LLM endpoints)
   */
  async getModelUsage(): Promise<
    Array<{
      model: string;
      totalRequests: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalRevenue: number;
    }>
  > {
    const results = this.sql
      .exec(
        `SELECT model, COUNT(*) as total_requests,
                COALESCE(SUM(input_tokens), 0) as total_input,
                COALESCE(SUM(output_tokens), 0) as total_output,
                SUM(amount_charged) as total_revenue
         FROM usage
         WHERE model IS NOT NULL
         GROUP BY model
         ORDER BY total_requests DESC`
      )
      .toArray();

    return results.map((row) => ({
      model: row.model as string,
      totalRequests: row.total_requests as number,
      totalInputTokens: row.total_input as number,
      totalOutputTokens: row.total_output as number,
      totalRevenue: row.total_revenue as number,
    }));
  }

  /**
   * Get token type distribution
   */
  async getTokenDistribution(): Promise<
    Array<{
      token: TokenType;
      totalRequests: number;
      totalRevenue: number;
    }>
  > {
    const results = this.sql
      .exec(
        `SELECT token, COUNT(*) as total_requests, SUM(amount_charged) as total_revenue
         FROM usage
         GROUP BY token
         ORDER BY total_revenue DESC`
      )
      .toArray();

    return results.map((row) => ({
      token: row.token as TokenType,
      totalRequests: row.total_requests as number,
      totalRevenue: row.total_revenue as number,
    }));
  }
}
