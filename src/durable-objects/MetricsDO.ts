/**
 * MetricsDO - Global Metrics Tracking Durable Object
 *
 * Tracks aggregate metrics across all payers for dashboard and analytics.
 * Unlike UsageDO (per-payer), this provides a global view.
 *
 * Enhanced metrics include:
 * - Error rates & types
 * - Response sizes
 * - Geographic distribution (CF datacenter)
 */

import { DurableObject } from "cloudflare:workers";
import type { Env, TokenType, PricingTier } from "../types";

// =============================================================================
// Types
// =============================================================================

export interface MetricsRecord {
  requestId: string;
  endpoint: string;
  category: string;
  method: string;
  statusCode: number;
  isSuccess: boolean;
  errorType?: string;
  pricingType: "fixed" | "dynamic";
  tier?: PricingTier;
  amountCharged: number; // microSTX equivalent
  token: TokenType;
  durationMs: number;
  responseBytes: number;
  colo: string; // CF datacenter code (e.g., "SJC", "AMS")
  payerAddress?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface EndpointStats {
  endpoint: string;
  category: string;
  totalCalls: number;
  successfulCalls: number;
  errorCalls: number;
  avgLatencyMs: number;
  totalBytes: number;
  earningsSTX: number;
  earningsSBTC: number;
  earningsUSDCx: number;
  created: string;
  lastCall: string;
}

export interface DailyStatsRow {
  date: string;
  totalCalls: number;
  successfulCalls: number;
  errorCalls: number;
  earningsSTX: number;
}

export interface ColoStats {
  colo: string;
  totalCalls: number;
  avgLatencyMs: number;
}

export interface ErrorStats {
  errorType: string;
  count: number;
  lastOccurred: string;
}

// =============================================================================
// MetricsDO Implementation
// =============================================================================

export class MetricsDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      this.initSchema();
    });
  }

  private initSchema(): void {
    this.sql.exec(`
      -- Per-request metrics log (for detailed queries, pruned after 30 days)
      CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT UNIQUE,
        endpoint TEXT NOT NULL,
        category TEXT NOT NULL,
        method TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        is_success INTEGER NOT NULL,
        error_type TEXT,
        pricing_type TEXT NOT NULL,
        tier TEXT,
        amount_charged INTEGER NOT NULL,
        token TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        response_bytes INTEGER NOT NULL,
        colo TEXT NOT NULL,
        payer_address TEXT,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        timestamp INTEGER NOT NULL
      );

      -- Aggregate endpoint stats (running totals)
      CREATE TABLE IF NOT EXISTS endpoint_stats (
        endpoint TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        total_calls INTEGER DEFAULT 0,
        successful_calls INTEGER DEFAULT 0,
        error_calls INTEGER DEFAULT 0,
        latency_sum INTEGER DEFAULT 0,
        total_bytes INTEGER DEFAULT 0,
        earnings_stx INTEGER DEFAULT 0,
        earnings_sbtc INTEGER DEFAULT 0,
        earnings_usdcx INTEGER DEFAULT 0,
        created TEXT NOT NULL,
        last_call TEXT NOT NULL
      );

      -- Daily aggregates
      CREATE TABLE IF NOT EXISTS daily_stats (
        date TEXT PRIMARY KEY,
        total_calls INTEGER DEFAULT 0,
        successful_calls INTEGER DEFAULT 0,
        error_calls INTEGER DEFAULT 0,
        earnings_stx INTEGER DEFAULT 0,
        earnings_sbtc INTEGER DEFAULT 0,
        earnings_usdcx INTEGER DEFAULT 0
      );

      -- Geographic distribution
      CREATE TABLE IF NOT EXISTS colo_stats (
        colo TEXT PRIMARY KEY,
        total_calls INTEGER DEFAULT 0,
        latency_sum INTEGER DEFAULT 0,
        last_seen TEXT NOT NULL
      );

      -- Error tracking
      CREATE TABLE IF NOT EXISTS error_stats (
        error_type TEXT PRIMARY KEY,
        count INTEGER DEFAULT 0,
        last_occurred TEXT NOT NULL
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(timestamp);
      CREATE INDEX IF NOT EXISTS idx_metrics_endpoint ON metrics(endpoint);
      CREATE INDEX IF NOT EXISTS idx_metrics_category ON metrics(category);
      CREATE INDEX IF NOT EXISTS idx_metrics_colo ON metrics(colo);
      CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date);
    `);
  }

  // ===========================================================================
  // Record Metrics
  // ===========================================================================

  async recordMetrics(record: MetricsRecord): Promise<void> {
    const now = new Date();
    const timestamp = now.getTime();
    const today = now.toISOString().split("T")[0];
    const nowIso = now.toISOString();

    // Calculate earnings based on token type (convert to micro units)
    const earningsStx = record.token === "STX" ? record.amountCharged : 0;
    const earningsSbtc = record.token === "sBTC" ? record.amountCharged : 0;
    const earningsUsdcx = record.token === "USDCx" ? record.amountCharged : 0;

    // Insert detailed metrics record
    this.sql.exec(
      `INSERT OR IGNORE INTO metrics (
        request_id, endpoint, category, method, status_code, is_success,
        error_type, pricing_type, tier, amount_charged, token, duration_ms,
        response_bytes, colo, payer_address, model, input_tokens, output_tokens, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.requestId,
      record.endpoint,
      record.category,
      record.method,
      record.statusCode,
      record.isSuccess ? 1 : 0,
      record.errorType || null,
      record.pricingType,
      record.tier || null,
      record.amountCharged,
      record.token,
      record.durationMs,
      record.responseBytes,
      record.colo,
      record.payerAddress || null,
      record.model || null,
      record.inputTokens || null,
      record.outputTokens || null,
      timestamp
    );

    // Update endpoint aggregate stats
    this.sql.exec(
      `INSERT INTO endpoint_stats (
        endpoint, category, total_calls, successful_calls, error_calls,
        latency_sum, total_bytes, earnings_stx, earnings_sbtc, earnings_usdcx,
        created, last_call
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET
        total_calls = total_calls + 1,
        successful_calls = successful_calls + excluded.successful_calls,
        error_calls = error_calls + excluded.error_calls,
        latency_sum = latency_sum + excluded.latency_sum,
        total_bytes = total_bytes + excluded.total_bytes,
        earnings_stx = earnings_stx + excluded.earnings_stx,
        earnings_sbtc = earnings_sbtc + excluded.earnings_sbtc,
        earnings_usdcx = earnings_usdcx + excluded.earnings_usdcx,
        last_call = excluded.last_call`,
      record.endpoint,
      record.category,
      record.isSuccess ? 1 : 0,
      record.isSuccess ? 0 : 1,
      record.durationMs,
      record.responseBytes,
      earningsStx,
      earningsSbtc,
      earningsUsdcx,
      nowIso,
      nowIso
    );

    // Update daily stats
    this.sql.exec(
      `INSERT INTO daily_stats (
        date, total_calls, successful_calls, error_calls,
        earnings_stx, earnings_sbtc, earnings_usdcx
      ) VALUES (?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        total_calls = total_calls + 1,
        successful_calls = successful_calls + excluded.successful_calls,
        error_calls = error_calls + excluded.error_calls,
        earnings_stx = earnings_stx + excluded.earnings_stx,
        earnings_sbtc = earnings_sbtc + excluded.earnings_sbtc,
        earnings_usdcx = earnings_usdcx + excluded.earnings_usdcx`,
      today,
      record.isSuccess ? 1 : 0,
      record.isSuccess ? 0 : 1,
      earningsStx,
      earningsSbtc,
      earningsUsdcx
    );

    // Update colo stats
    this.sql.exec(
      `INSERT INTO colo_stats (colo, total_calls, latency_sum, last_seen)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(colo) DO UPDATE SET
         total_calls = total_calls + 1,
         latency_sum = latency_sum + excluded.latency_sum,
         last_seen = excluded.last_seen`,
      record.colo,
      record.durationMs,
      nowIso
    );

    // Update error stats if this was an error
    if (!record.isSuccess && record.errorType) {
      this.sql.exec(
        `INSERT INTO error_stats (error_type, count, last_occurred)
         VALUES (?, 1, ?)
         ON CONFLICT(error_type) DO UPDATE SET
           count = count + 1,
           last_occurred = excluded.last_occurred`,
        record.errorType,
        nowIso
      );
    }

    // Prune old detailed metrics (keep 30 days)
    const cutoffTs = timestamp - 30 * 24 * 60 * 60 * 1000;
    this.sql.exec("DELETE FROM metrics WHERE timestamp < ?", cutoffTs);

    // Prune old daily stats (keep 90 days)
    const cutoffDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];
    this.sql.exec("DELETE FROM daily_stats WHERE date < ?", cutoffDate);
  }

  // ===========================================================================
  // Dashboard Queries
  // ===========================================================================

  /**
   * Get all endpoint stats for dashboard
   */
  async getEndpointStats(): Promise<EndpointStats[]> {
    const results = this.sql
      .exec(
        `SELECT endpoint, category, total_calls, successful_calls, error_calls,
                latency_sum, total_bytes, earnings_stx, earnings_sbtc, earnings_usdcx,
                created, last_call
         FROM endpoint_stats
         ORDER BY total_calls DESC`
      )
      .toArray();

    return results.map((row) => ({
      endpoint: row.endpoint as string,
      category: row.category as string,
      totalCalls: row.total_calls as number,
      successfulCalls: row.successful_calls as number,
      errorCalls: row.error_calls as number,
      avgLatencyMs:
        (row.total_calls as number) > 0
          ? Math.round((row.latency_sum as number) / (row.total_calls as number))
          : 0,
      totalBytes: row.total_bytes as number,
      earningsSTX: row.earnings_stx as number,
      earningsSBTC: row.earnings_sbtc as number,
      earningsUSDCx: row.earnings_usdcx as number,
      created: row.created as string,
      lastCall: row.last_call as string,
    }));
  }

  /**
   * Get daily stats for charts
   */
  async getDailyStats(days: number = 7): Promise<DailyStatsRow[]> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const results = this.sql
      .exec(
        `SELECT date, total_calls, successful_calls, error_calls, earnings_stx
         FROM daily_stats
         WHERE date >= ?
         ORDER BY date ASC`,
        cutoff
      )
      .toArray();

    // Fill in missing days with zeros
    const statsMap = new Map<string, DailyStatsRow>();
    for (const row of results) {
      statsMap.set(row.date as string, {
        date: row.date as string,
        totalCalls: row.total_calls as number,
        successfulCalls: row.successful_calls as number,
        errorCalls: row.error_calls as number,
        earningsSTX: row.earnings_stx as number,
      });
    }

    const allDays: DailyStatsRow[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];
      allDays.push(
        statsMap.get(date) || {
          date,
          totalCalls: 0,
          successfulCalls: 0,
          errorCalls: 0,
          earningsSTX: 0,
        }
      );
    }

    return allDays;
  }

  /**
   * Get geographic distribution
   */
  async getColoStats(): Promise<ColoStats[]> {
    const results = this.sql
      .exec(
        `SELECT colo, total_calls, latency_sum
         FROM colo_stats
         ORDER BY total_calls DESC
         LIMIT 20`
      )
      .toArray();

    return results.map((row) => ({
      colo: row.colo as string,
      totalCalls: row.total_calls as number,
      avgLatencyMs:
        (row.total_calls as number) > 0
          ? Math.round((row.latency_sum as number) / (row.total_calls as number))
          : 0,
    }));
  }

  /**
   * Get error statistics
   */
  async getErrorStats(): Promise<ErrorStats[]> {
    const results = this.sql
      .exec(
        `SELECT error_type, count, last_occurred
         FROM error_stats
         ORDER BY count DESC
         LIMIT 20`
      )
      .toArray();

    return results.map((row) => ({
      errorType: row.error_type as string,
      count: row.count as number,
      lastOccurred: row.last_occurred as string,
    }));
  }

  /**
   * Get summary totals for dashboard header
   */
  async getSummary(): Promise<{
    totalEndpoints: number;
    totalCalls: number;
    totalSuccessful: number;
    totalErrors: number;
    avgSuccessRate: number;
    earningsSTX: number;
    earningsSBTC: number;
    earningsUSDCx: number;
    uniqueColos: number;
  }> {
    const endpointCount = this.sql
      .exec("SELECT COUNT(*) as cnt FROM endpoint_stats")
      .toArray()[0]?.cnt as number || 0;

    const totals = this.sql
      .exec(
        `SELECT
          COALESCE(SUM(total_calls), 0) as total_calls,
          COALESCE(SUM(successful_calls), 0) as successful,
          COALESCE(SUM(error_calls), 0) as errors,
          COALESCE(SUM(earnings_stx), 0) as stx,
          COALESCE(SUM(earnings_sbtc), 0) as sbtc,
          COALESCE(SUM(earnings_usdcx), 0) as usdcx
         FROM endpoint_stats`
      )
      .toArray()[0];

    const coloCount = this.sql
      .exec("SELECT COUNT(*) as cnt FROM colo_stats")
      .toArray()[0]?.cnt as number || 0;

    const totalCalls = (totals?.total_calls as number) || 0;
    const successful = (totals?.successful as number) || 0;

    return {
      totalEndpoints: endpointCount,
      totalCalls,
      totalSuccessful: successful,
      totalErrors: (totals?.errors as number) || 0,
      avgSuccessRate: totalCalls > 0 ? (successful / totalCalls) * 100 : 0,
      earningsSTX: (totals?.stx as number) || 0,
      earningsSBTC: (totals?.sbtc as number) || 0,
      earningsUSDCx: (totals?.usdcx as number) || 0,
      uniqueColos: coloCount,
    };
  }

  /**
   * Get recent requests (for live feed)
   */
  async getRecentRequests(limit: number = 20): Promise<
    Array<{
      requestId: string;
      endpoint: string;
      statusCode: number;
      durationMs: number;
      colo: string;
      timestamp: string;
    }>
  > {
    const results = this.sql
      .exec(
        `SELECT request_id, endpoint, status_code, duration_ms, colo, timestamp
         FROM metrics
         ORDER BY timestamp DESC
         LIMIT ?`,
        limit
      )
      .toArray();

    return results.map((row) => ({
      requestId: row.request_id as string,
      endpoint: row.endpoint as string,
      statusCode: row.status_code as number,
      durationMs: row.duration_ms as number,
      colo: row.colo as string,
      timestamp: new Date(row.timestamp as number).toISOString(),
    }));
  }

  /**
   * Get model usage stats (for LLM endpoints)
   */
  async getModelStats(): Promise<
    Array<{
      model: string;
      totalCalls: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalEarningsSTX: number;
    }>
  > {
    const results = this.sql
      .exec(
        `SELECT model,
                COUNT(*) as total_calls,
                COALESCE(SUM(input_tokens), 0) as input_tokens,
                COALESCE(SUM(output_tokens), 0) as output_tokens,
                COALESCE(SUM(CASE WHEN token = 'STX' THEN amount_charged ELSE 0 END), 0) as earnings
         FROM metrics
         WHERE model IS NOT NULL
         GROUP BY model
         ORDER BY total_calls DESC`
      )
      .toArray();

    return results.map((row) => ({
      model: row.model as string,
      totalCalls: row.total_calls as number,
      totalInputTokens: row.input_tokens as number,
      totalOutputTokens: row.output_tokens as number,
      totalEarningsSTX: row.earnings as number,
    }));
  }
}
