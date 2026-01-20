/**
 * StorageDO - Per-payer Storage Durable Object
 *
 * Provides isolated storage for each payer address:
 * - Key-Value store
 * - Paste bin
 * - SQL database
 * - Distributed locks (sync)
 * - Job queue
 * - Vector memory with embeddings
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";

// Alphanumeric characters for ID generation
const ID_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * Generate a random alphanumeric string
 */
function generateRandomString(length: number, prefix = ""): string {
  let result = prefix;
  for (let i = 0; i < length; i++) {
    result += ID_CHARS.charAt(Math.floor(Math.random() * ID_CHARS.length));
  }
  return result;
}

/**
 * Safely parse a JSON string field into a Record
 * Returns null if parsing fails or value is falsy
 */
function parseJsonField(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value as string);
  } catch {
    return null;
  }
}

export class StorageDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private initialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  /**
   * Initialize the database schema (called lazily)
   */
  private initializeSchema(): void {
    if (this.initialized) return;

    // KV table
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        metadata TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Paste table
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pastes (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        title TEXT,
        language TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL
      )
    `);

    // Locks table for distributed locking
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS locks (
        name TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        acquired_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_locks_expires ON locks(expires_at)`);

    // Jobs table for queue functionality
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        queue TEXT NOT NULL,
        payload TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        available_at TEXT NOT NULL,
        visibility_timeout TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        failed_at TEXT,
        error TEXT
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_queue_status ON jobs(queue, status)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_available ON jobs(queue, status, available_at, priority DESC)`);

    // Memories table for agent memory system
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        key TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        summary TEXT,
        tags TEXT,
        type TEXT DEFAULT 'note',
        importance INTEGER DEFAULT 5,
        source TEXT,
        embedding TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC)`);

    this.initialized = true;
  }

  // ===========================================================================
  // KV Operations
  // ===========================================================================

  async kvSet(
    key: string,
    value: string,
    options?: { metadata?: Record<string, unknown>; ttl?: number }
  ): Promise<{ key: string; created: boolean }> {
    this.initializeSchema();
    const now = new Date().toISOString();
    const expiresAt = options?.ttl
      ? new Date(Date.now() + options.ttl * 1000).toISOString()
      : null;
    const metadata = options?.metadata ? JSON.stringify(options.metadata) : null;

    const existing = this.sql
      .exec("SELECT 1 FROM kv WHERE key = ?", key)
      .toArray();

    if (existing.length > 0) {
      this.sql.exec(
        `UPDATE kv SET value = ?, metadata = ?, expires_at = ?, updated_at = ? WHERE key = ?`,
        value, metadata, expiresAt, now, key
      );
      return { key, created: false };
    }

    this.sql.exec(
      `INSERT INTO kv (key, value, metadata, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      key, value, metadata, expiresAt, now, now
    );
    return { key, created: true };
  }

  async kvGet(key: string): Promise<{
    key: string;
    value: string;
    metadata: Record<string, unknown> | null;
    createdAt: string;
    updatedAt: string;
  } | null> {
    this.initializeSchema();

    // Clean up expired entries
    this.sql.exec(
      "DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at < ?",
      new Date().toISOString()
    );

    const result = this.sql
      .exec("SELECT value, metadata, created_at, updated_at FROM kv WHERE key = ?", key)
      .toArray();

    if (result.length === 0) return null;

    const row = result[0];
    return {
      key,
      value: row.value as string,
      metadata: parseJsonField(row.metadata),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  async kvDelete(key: string): Promise<{ deleted: boolean }> {
    this.initializeSchema();
    const existing = this.sql.exec("SELECT 1 FROM kv WHERE key = ?", key).toArray();
    if (existing.length === 0) return { deleted: false };

    this.sql.exec("DELETE FROM kv WHERE key = ?", key);
    return { deleted: true };
  }

  async kvList(options?: { prefix?: string; limit?: number }): Promise<
    Array<{
      key: string;
      metadata: Record<string, unknown> | null;
      updatedAt: string;
    }>
  > {
    this.initializeSchema();
    const limit = Math.min(options?.limit || 100, 1000);

    // Clean up expired entries
    this.sql.exec(
      "DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at < ?",
      new Date().toISOString()
    );

    let query = "SELECT key, metadata, updated_at FROM kv";
    const params: unknown[] = [];

    if (options?.prefix) {
      query += " WHERE key LIKE ?";
      params.push(`${options.prefix}%`);
    }
    query += " ORDER BY key LIMIT ?";
    params.push(limit);

    const results = this.sql.exec(query, ...params).toArray();

    return results.map((row) => ({
      key: row.key as string,
      metadata: parseJsonField(row.metadata),
      updatedAt: row.updated_at as string,
    }));
  }

  // ===========================================================================
  // Paste Operations
  // ===========================================================================

  async pasteCreate(
    content: string,
    options?: { title?: string; language?: string; ttl?: number }
  ): Promise<{ id: string; createdAt: string; expiresAt: string | null }> {
    this.initializeSchema();
    const now = new Date().toISOString();
    const id = generateRandomString(8);
    const expiresAt = options?.ttl
      ? new Date(Date.now() + options.ttl * 1000).toISOString()
      : null;

    this.sql.exec(
      `INSERT INTO pastes (id, content, title, language, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id, content, options?.title || null, options?.language || null, expiresAt, now
    );

    return { id, createdAt: now, expiresAt };
  }

  async pasteGet(id: string): Promise<{
    id: string;
    content: string;
    title: string | null;
    language: string | null;
    createdAt: string;
    expiresAt: string | null;
  } | null> {
    this.initializeSchema();

    // Clean up expired
    this.sql.exec(
      "DELETE FROM pastes WHERE expires_at IS NOT NULL AND expires_at < ?",
      new Date().toISOString()
    );

    const result = this.sql
      .exec("SELECT content, title, language, created_at, expires_at FROM pastes WHERE id = ?", id)
      .toArray();

    if (result.length === 0) return null;

    const row = result[0];
    return {
      id,
      content: row.content as string,
      title: row.title as string | null,
      language: row.language as string | null,
      createdAt: row.created_at as string,
      expiresAt: row.expires_at as string | null,
    };
  }

  async pasteDelete(id: string): Promise<{ deleted: boolean }> {
    this.initializeSchema();
    const existing = this.sql.exec("SELECT 1 FROM pastes WHERE id = ?", id).toArray();
    if (existing.length === 0) return { deleted: false };

    this.sql.exec("DELETE FROM pastes WHERE id = ?", id);
    return { deleted: true };
  }

  // ===========================================================================
  // SQL Database Operations
  // ===========================================================================

  async sqlQuery(query: string, params: unknown[] = []): Promise<{
    rows: unknown[];
    rowCount: number;
    columns: string[];
  }> {
    this.initializeSchema();

    // Security: Only allow SELECT queries
    const normalizedQuery = query.trim().toUpperCase();
    if (!normalizedQuery.startsWith("SELECT")) {
      throw new Error("Only SELECT queries are allowed");
    }

    // Prevent dangerous patterns
    const dangerous = ["DROP", "DELETE", "INSERT", "UPDATE", "CREATE", "ALTER", "PRAGMA"];
    for (const keyword of dangerous) {
      if (normalizedQuery.includes(keyword)) {
        throw new Error(`Query contains forbidden keyword: ${keyword}`);
      }
    }

    const cursor = this.sql.exec(query, ...params);
    const rows = cursor.toArray();
    const columns = rows.length > 0 ? Object.keys(rows[0] as object) : [];

    return { rows, rowCount: rows.length, columns };
  }

  async sqlExecute(query: string, params: unknown[] = []): Promise<{
    success: boolean;
    rowsAffected: number;
  }> {
    this.initializeSchema();

    // Security: Prevent modification of system tables
    const normalizedQuery = query.trim().toUpperCase();
    const systemTables = ["KV", "PASTES", "LOCKS", "JOBS", "MEMORIES"];

    for (const table of systemTables) {
      if ((normalizedQuery.includes("DROP") || normalizedQuery.includes("ALTER")) &&
          normalizedQuery.includes(table)) {
        throw new Error(`Cannot modify system table: ${table.toLowerCase()}`);
      }
    }

    if (normalizedQuery.startsWith("PRAGMA") && normalizedQuery.includes("=")) {
      throw new Error("Cannot modify PRAGMA settings");
    }

    const cursor = this.sql.exec(query, ...params);
    return { success: true, rowsAffected: cursor.rowsWritten };
  }

  async sqlSchema(): Promise<{ tables: Array<{ name: string; sql: string }> }> {
    this.initializeSchema();
    const tables = this.sql
      .exec("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .toArray();

    return {
      tables: tables.map((row) => ({
        name: row.name as string,
        sql: row.sql as string,
      })),
    };
  }

  // ===========================================================================
  // Lock Operations (Sync)
  // ===========================================================================

  private cleanupExpiredLocks(): void {
    this.sql.exec("DELETE FROM locks WHERE expires_at < ?", new Date().toISOString());
  }

  async syncLock(name: string, options?: { ttl?: number }): Promise<{
    acquired: boolean;
    token: string | null;
    expiresAt: string | null;
    heldUntil?: string;
  }> {
    this.initializeSchema();
    this.cleanupExpiredLocks();

    const now = new Date();
    const ttl = Math.min(Math.max(options?.ttl ?? 60, 10), 300);
    const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();

    const existing = this.sql
      .exec("SELECT token, expires_at FROM locks WHERE name = ?", name)
      .toArray();

    if (existing.length > 0) {
      const lock = existing[0];
      const lockExpiresAt = lock.expires_at as string;
      if (new Date(lockExpiresAt) > now) {
        return { acquired: false, token: null, expiresAt: null, heldUntil: lockExpiresAt };
      }
      this.sql.exec("DELETE FROM locks WHERE name = ?", name);
    }

    const token = generateRandomString(32);
    this.sql.exec(
      `INSERT INTO locks (name, token, expires_at, acquired_at) VALUES (?, ?, ?, ?)`,
      name, token, expiresAt, now.toISOString()
    );

    return { acquired: true, token, expiresAt };
  }

  async syncUnlock(name: string, token: string): Promise<{ released: boolean; error?: string }> {
    this.initializeSchema();

    const existing = this.sql
      .exec("SELECT token FROM locks WHERE name = ?", name)
      .toArray();

    if (existing.length === 0) return { released: false, error: "Lock not found" };
    if (existing[0].token !== token) return { released: false, error: "Invalid token" };

    this.sql.exec("DELETE FROM locks WHERE name = ? AND token = ?", name, token);
    return { released: true };
  }

  async syncExtend(name: string, token: string, options?: { ttl?: number }): Promise<{
    extended: boolean;
    expiresAt: string | null;
    error?: string;
  }> {
    this.initializeSchema();

    const existing = this.sql
      .exec("SELECT token, expires_at FROM locks WHERE name = ?", name)
      .toArray();

    if (existing.length === 0) return { extended: false, expiresAt: null, error: "Lock not found" };
    if (existing[0].token !== token) return { extended: false, expiresAt: null, error: "Invalid token" };
    if (new Date(existing[0].expires_at as string) < new Date()) {
      this.sql.exec("DELETE FROM locks WHERE name = ?", name);
      return { extended: false, expiresAt: null, error: "Lock has expired" };
    }

    const ttl = Math.min(Math.max(options?.ttl ?? 60, 10), 300);
    const newExpiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    this.sql.exec("UPDATE locks SET expires_at = ? WHERE name = ? AND token = ?", newExpiresAt, name, token);

    return { extended: true, expiresAt: newExpiresAt };
  }

  async syncStatus(name: string): Promise<{
    locked: boolean;
    expiresAt: string | null;
    acquiredAt: string | null;
  }> {
    this.initializeSchema();
    this.cleanupExpiredLocks();

    const existing = this.sql
      .exec("SELECT expires_at, acquired_at FROM locks WHERE name = ?", name)
      .toArray();

    if (existing.length === 0) return { locked: false, expiresAt: null, acquiredAt: null };

    return {
      locked: true,
      expiresAt: existing[0].expires_at as string,
      acquiredAt: existing[0].acquired_at as string,
    };
  }

  async syncList(): Promise<Array<{ name: string; expiresAt: string; acquiredAt: string }>> {
    this.initializeSchema();
    this.cleanupExpiredLocks();

    return this.sql
      .exec("SELECT name, expires_at, acquired_at FROM locks ORDER BY acquired_at DESC")
      .toArray()
      .map((row) => ({
        name: row.name as string,
        expiresAt: row.expires_at as string,
        acquiredAt: row.acquired_at as string,
      }));
  }

  // ===========================================================================
  // Queue Operations
  // ===========================================================================

  private cleanupVisibilityTimeouts(queue: string): void {
    const now = new Date().toISOString();
    this.sql.exec(
      `UPDATE jobs SET status = 'pending', visibility_timeout = NULL, updated_at = ?, attempt = attempt + 1
       WHERE queue = ? AND status = 'processing' AND visibility_timeout < ?`,
      now, queue, now
    );
  }

  async queuePush(queue: string, items: unknown[], options?: {
    priority?: number;
  }): Promise<{ pushed: number; queue: string }> {
    this.initializeSchema();
    const now = new Date();
    const nowStr = now.toISOString();
    const priority = options?.priority ?? 0;

    for (const item of items) {
      const jobId = generateRandomString(16, "job_");
      this.sql.exec(
        `INSERT INTO jobs (id, queue, payload, priority, status, max_attempts, available_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 3, ?, ?, ?)`,
        jobId, queue, JSON.stringify(item), priority, nowStr, nowStr, nowStr
      );
    }

    return { pushed: items.length, queue };
  }

  async queuePop(queue: string, count: number = 1): Promise<{
    items: Array<{ id: string; data: unknown }>;
    count: number;
  }> {
    this.initializeSchema();
    this.cleanupVisibilityTimeouts(queue);

    const now = new Date();
    const nowStr = now.toISOString();
    const safeCount = Math.min(Math.max(count, 1), 100);

    const jobs = this.sql
      .exec(
        `SELECT id, payload FROM jobs
         WHERE queue = ? AND status = 'pending' AND available_at <= ?
         ORDER BY priority DESC, created_at ASC
         LIMIT ?`,
        queue, nowStr, safeCount
      )
      .toArray();

    const items: Array<{ id: string; data: unknown }> = [];

    for (const job of jobs) {
      const jobId = job.id as string;
      // Delete the job (pop = remove from queue)
      this.sql.exec("DELETE FROM jobs WHERE id = ?", jobId);

      let data: unknown;
      try { data = JSON.parse(job.payload as string); } catch { data = job.payload; }
      items.push({ id: jobId, data });
    }

    return { items, count: items.length };
  }

  async queuePeek(queue: string, count: number = 10): Promise<{
    items: Array<{ id: string; data: unknown; priority: number }>;
    count: number;
  }> {
    this.initializeSchema();
    this.cleanupVisibilityTimeouts(queue);

    const safeCount = Math.min(Math.max(count, 1), 100);
    const jobs = this.sql
      .exec(
        `SELECT id, payload, priority FROM jobs
         WHERE queue = ? AND status = 'pending'
         ORDER BY priority DESC, created_at ASC
         LIMIT ?`,
        queue, safeCount
      )
      .toArray();

    const items = jobs.map((row) => {
      let data: unknown;
      try { data = JSON.parse(row.payload as string); } catch { data = row.payload; }
      return {
        id: row.id as string,
        data,
        priority: row.priority as number,
      };
    });

    return { items, count: items.length };
  }

  async queueStatus(queue: string): Promise<{
    queue: string;
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  }> {
    this.initializeSchema();
    this.cleanupVisibilityTimeouts(queue);

    const counts = this.sql
      .exec(`SELECT status, COUNT(*) as count FROM jobs WHERE queue = ? GROUP BY status`, queue)
      .toArray();

    const statusCounts: Record<string, number> = { pending: 0, processing: 0, completed: 0, failed: 0, dead: 0 };
    for (const row of counts) {
      statusCounts[row.status as string] = row.count as number;
    }

    return {
      queue,
      pending: statusCounts.pending,
      processing: statusCounts.processing,
      completed: statusCounts.completed,
      failed: statusCounts.failed + statusCounts.dead,
    };
  }

  async queueClear(queue: string, options?: { status?: string }): Promise<{ cleared: number }> {
    this.initializeSchema();

    let result;
    if (options?.status) {
      result = this.sql.exec("DELETE FROM jobs WHERE queue = ? AND status = ?", queue, options.status);
    } else {
      result = this.sql.exec("DELETE FROM jobs WHERE queue = ?", queue);
    }

    return { cleared: result.rowsWritten };
  }

  // ===========================================================================
  // Memory Operations
  // ===========================================================================

  /**
   * Store one or more items with embeddings (batch operation)
   */
  async memoryStore(items: Array<{
    id: string;
    text: string;
    embedding: number[];
    metadata?: Record<string, unknown>;
  }>): Promise<{ stored: number; items: string[] }> {
    this.initializeSchema();
    const now = new Date().toISOString();
    const storedIds: string[] = [];

    for (const item of items) {
      const embeddingStr = JSON.stringify(item.embedding);
      const metadataStr = item.metadata ? JSON.stringify(item.metadata) : null;

      const existing = this.sql.exec("SELECT 1 FROM memories WHERE key = ?", item.id).toArray();

      if (existing.length > 0) {
        this.sql.exec(
          `UPDATE memories SET content = ?, tags = ?, embedding = ?, updated_at = ? WHERE key = ?`,
          item.text, metadataStr, embeddingStr, now, item.id
        );
      } else {
        this.sql.exec(
          `INSERT INTO memories (key, content, tags, type, importance, embedding, created_at, updated_at)
           VALUES (?, ?, ?, 'embedding', 5, ?, ?, ?)`,
          item.id, item.text, metadataStr, embeddingStr, now, now
        );
      }
      storedIds.push(item.id);
    }

    return { stored: storedIds.length, items: storedIds };
  }

  async memorySearch(queryEmbedding: number[], options?: {
    limit?: number;
    threshold?: number;
  }): Promise<{ results: Array<{ id: string; text: string; metadata: Record<string, unknown> | null; similarity: number }> }> {
    this.initializeSchema();

    // Clean up expired
    this.sql.exec(
      "DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?",
      new Date().toISOString()
    );

    const limit = Math.min(options?.limit ?? 10, 100);
    const threshold = options?.threshold ?? 0.5;

    const results = this.sql
      .exec("SELECT key, content, tags, embedding FROM memories WHERE embedding IS NOT NULL")
      .toArray();

    const scored: Array<{ id: string; text: string; metadata: Record<string, unknown> | null; similarity: number }> = [];

    for (const row of results) {
      let storedEmbedding: number[];
      try { storedEmbedding = JSON.parse(row.embedding as string); } catch { continue; }

      const similarity = this.cosineSimilarity(queryEmbedding, storedEmbedding);
      if (similarity < threshold) continue;

      scored.push({
        id: row.key as string,
        text: row.content as string,
        metadata: parseJsonField(row.tags),
        similarity,
      });
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return { results: scored.slice(0, limit) };
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }

  async memoryDelete(ids: string[]): Promise<{ deleted: number; ids: string[] }> {
    this.initializeSchema();
    const deletedIds: string[] = [];

    for (const id of ids) {
      const existing = this.sql.exec("SELECT 1 FROM memories WHERE key = ?", id).toArray();
      if (existing.length > 0) {
        this.sql.exec("DELETE FROM memories WHERE key = ?", id);
        deletedIds.push(id);
      }
    }

    return { deleted: deletedIds.length, ids: deletedIds };
  }

  async memoryList(options?: { limit?: number; offset?: number }): Promise<{
    items: Array<{ id: string; text: string; metadata: Record<string, unknown> | null; createdAt: string }>;
    total: number;
  }> {
    this.initializeSchema();
    const limit = Math.min(options?.limit ?? 100, 1000);
    const offset = options?.offset ?? 0;

    // Clean up expired
    this.sql.exec(
      "DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?",
      new Date().toISOString()
    );

    const countResult = this.sql.exec("SELECT COUNT(*) as count FROM memories").toArray();
    const total = (countResult[0]?.count as number) || 0;

    const results = this.sql
      .exec("SELECT key, content, tags, created_at FROM memories ORDER BY created_at DESC LIMIT ? OFFSET ?", limit, offset)
      .toArray();

    const items = results.map((row) => ({
      id: row.key as string,
      text: row.content as string,
      metadata: parseJsonField(row.tags),
      createdAt: row.created_at as string,
    }));

    return { items, total };
  }

  async memoryClear(): Promise<{ cleared: number }> {
    this.initializeSchema();
    const result = this.sql.exec("DELETE FROM memories");
    return { cleared: result.rowsWritten };
  }
}
