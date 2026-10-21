/**
 * Hiro API Service
 *
 * Client for the Hiro Stacks API with 429 resilience, short TTL caching,
 * and Retry-After / rate-limit header handling.
 * https://docs.hiro.so/stacks/api
 */

import type { Logger } from "../types";

// =============================================================================
// Constants
// =============================================================================

const HIRO_API_BASE = "https://api.hiro.so";

const DEFAULT_429_BACKOFF_MS = [1000, 2000, 4000] as const;
const DEFAULT_MAX_429_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 10_000;
const LOW_QUOTA_PAUSE_MS = 250;

/** Block height cache TTL — shared per network */
const CACHE_TTL_BLOCK_MS = 60_000;
/** Balance / account info cache TTL per (network, address) */
const CACHE_TTL_BALANCE_MS = 20_000;
/** BNS name lookup cache TTL per (network, address) */
const CACHE_TTL_BNS_MS = 3_600_000;

// =============================================================================
// Types
// =============================================================================

export interface AccountBalance {
  stx: {
    balance: string;
    total_sent: string;
    total_received: string;
    total_fees_sent: string;
    total_miner_rewards_received: string;
    lock_tx_id: string;
    locked: string;
    lock_height: number;
    burnchain_lock_height: number;
    burnchain_unlock_height: number;
  };
  fungible_tokens: Record<
    string,
    {
      balance: string;
      total_sent: string;
      total_received: string;
    }
  >;
  non_fungible_tokens: Record<
    string,
    {
      count: string;
      total_sent: string;
      total_received: string;
    }
  >;
}

export interface AccountInfo {
  balance: string;
  locked: string;
  unlock_height: number;
  nonce: number;
  balance_proof: string;
  nonce_proof: string;
}

export interface BnsName {
  name: string;
  namespace: string;
  zonefile: string;
  zonefile_hash: string;
  owner: string;
}

export interface Transaction {
  tx_id: string;
  nonce: number;
  fee_rate: string;
  sender_address: string;
  sponsored: boolean;
  post_condition_mode: string;
  post_conditions: unknown[];
  anchor_mode: string;
  block_hash: string;
  block_height: number;
  burn_block_time: number;
  burn_block_time_iso: string;
  canonical: boolean;
  tx_index: number;
  tx_status: string;
  tx_result: {
    hex: string;
    repr: string;
  };
  tx_type: string;
  [key: string]: unknown;
}

export interface BlockInfo {
  height: number;
  hash: string;
  burn_block_time: number;
  burn_block_time_iso: string;
}

export interface FetchHiroJsonOptions {
  /** Delays (ms) before each 429 retry; defaults to [1000, 2000, 4000] */
  retry429DelaysMs?: number[];
  /** Max 429 retries after the initial attempt (default 3) */
  max429Retries?: number;
  /** Injectable sleep for unit tests */
  sleepFn?: (ms: number) => Promise<void>;
  /** Injectable fetch for unit tests */
  fetchFn?: typeof fetch;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// =============================================================================
// Module-level cache (isolate-scoped, like model-cache)
// =============================================================================

const hiroResponseCache = new Map<string, CacheEntry<unknown>>();
const hiroInflight = new Map<string, Promise<unknown>>();

export function clearHiroCacheForTesting(): void {
  hiroResponseCache.clear();
  hiroInflight.clear();
}

function cacheKey(parts: string[]): string {
  return parts.join(":");
}

async function withCache<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>
): Promise<T> {
  const now = Date.now();
  const existing = hiroResponseCache.get(key);
  if (existing && existing.expiresAt > now) {
    return existing.value as T;
  }

  const inflight = hiroInflight.get(key);
  if (inflight) {
    return inflight as Promise<T>;
  }

  const promise = loader()
    .then((value) => {
      hiroResponseCache.set(key, { value, expiresAt: Date.now() + ttlMs });
      hiroInflight.delete(key);
      return value;
    })
    .catch((err) => {
      hiroInflight.delete(key);
      throw err;
    });

  hiroInflight.set(key, promise);
  return promise;
}

// =============================================================================
// Error Class
// =============================================================================

export class HiroApiError extends Error {
  public status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "HiroApiError";
    this.status = status;
  }
}

/** @deprecated Prefer HiroApiError — kept for existing endpoint imports */
export class HiroError extends HiroApiError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = "HiroError";
  }
}

// =============================================================================
// Fetch helpers
// =============================================================================

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function parseRetryAfterMs(header: string | null, nowMs: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const asSecs = parseInt(trimmed, 10);
  if (!Number.isNaN(asSecs) && String(asSecs) === trimmed) {
    return Math.min(Math.max(0, asSecs * 1000), MAX_RETRY_AFTER_MS);
  }
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    return Math.min(Math.max(0, asDate - nowMs), MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

function getRateLimitRemaining(headers: Headers): number | undefined {
  const raw =
    headers.get("x-ratelimit-remaining-stacks-second") ??
    headers.get("x-ratelimit-remaining");
  if (raw === null) return undefined;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? undefined : n;
}

async function maybePauseForLowQuota(
  headers: Headers,
  log: Logger,
  sleepFn: (ms: number) => Promise<void>
): Promise<void> {
  const remaining = getRateLimitRemaining(headers);
  if (remaining !== undefined && remaining <= 1) {
    log.debug("Hiro rate limit quota low, pausing briefly", { remaining });
    await sleepFn(LOW_QUOTA_PAUSE_MS);
  }
}

function delayBefore429Retry(
  attemptIndex: number,
  retry429DelaysMs: number[],
  retryAfterHeader: string | null
): number {
  const backoff = retry429DelaysMs[attemptIndex] ?? retry429DelaysMs[retry429DelaysMs.length - 1] ?? 1000;
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
  if (retryAfterMs !== undefined) {
    return Math.max(backoff, retryAfterMs);
  }
  return backoff;
}

/**
 * Fetch JSON from Hiro with 429 exponential backoff and Retry-After support.
 */
export async function fetchHiroJson<T>(
  url: string,
  init: RequestInit,
  log: Logger,
  options: FetchHiroJsonOptions = {}
): Promise<{ data: T; response: Response }> {
  const {
    retry429DelaysMs = [...DEFAULT_429_BACKOFF_MS],
    max429Retries = DEFAULT_MAX_429_RETRIES,
    sleepFn = defaultSleep,
    fetchFn = fetch,
  } = options;

  let lastError: HiroApiError | undefined;
  let lastResponse: Response | undefined;

  for (let attempt = 0; attempt <= max429Retries; attempt++) {
    const response = await fetchFn(url, init);
    lastResponse = response;

    if (response.ok) {
      await maybePauseForLowQuota(response.headers, log, sleepFn);
      const data = (await response.json()) as T;
      return { data, response };
    }

    const errorText = await response.text();

    if (response.status === 429 && attempt < max429Retries) {
      const delayMs = delayBefore429Retry(attempt, retry429DelaysMs, response.headers.get("Retry-After"));
      log.warn("Hiro API rate limited (429), retrying", {
        url,
        attempt: attempt + 1,
        max429Retries,
        delayMs,
      });
      await sleepFn(delayMs);
      continue;
    }

    if (response.status === 429) {
      lastError = new HiroApiError(`Hiro rate limit exceeded: ${errorText || "429"}`, 429);
      break;
    }

    log.error("Hiro API request failed", { url, status: response.status, error: errorText });
    throw new HiroApiError(
      `Hiro request failed: ${response.status}${errorText ? ` — ${errorText.slice(0, 200)}` : ""}`,
      response.status
    );
  }

  if (lastError) {
    throw lastError;
  }

  throw new HiroApiError(
    `Hiro request failed: ${lastResponse?.status ?? "unknown"}`,
    lastResponse?.status ?? 500
  );
}

// =============================================================================
// Hiro Client
// =============================================================================

export class HiroClient {
  private apiKey?: string;
  private log: Logger;
  private network: "mainnet" | "testnet";
  private fetchOptions: FetchHiroJsonOptions;

  constructor(
    logger: Logger,
    network: "mainnet" | "testnet" = "mainnet",
    apiKey?: string,
    fetchOptions?: FetchHiroJsonOptions
  ) {
    this.log = logger;
    this.network = network;
    this.apiKey = apiKey;
    this.fetchOptions = fetchOptions ?? {};
  }

  private get baseUrl(): string {
    return this.network === "testnet" ? "https://api.testnet.hiro.so" : HIRO_API_BASE;
  }

  private getHeaders(): HeadersInit {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }
    return headers;
  }

  private async fetchJson<T>(path: string, context: string): Promise<T> {
    try {
      const { data } = await fetchHiroJson<T>(
        `${this.baseUrl}${path}`,
        { headers: this.getHeaders() },
        this.log,
        this.fetchOptions
      );
      return data;
    } catch (error) {
      if (error instanceof HiroApiError) {
        throw new HiroError(`Failed to ${context}: ${error.status}`, error.status);
      }
      throw error;
    }
  }

  /**
   * Get account balance (cached ~20s per network+address)
   */
  async getAccountBalance(address: string): Promise<AccountBalance> {
    this.log.debug("Fetching account balance", { address });
    const key = cacheKey(["balance", this.network, address]);
    return withCache(key, CACHE_TTL_BALANCE_MS, () =>
      this.fetchJson<AccountBalance>(`/extended/v1/address/${address}/balances`, "fetch balance")
    );
  }

  /**
   * Get account info (nonce, balance) — cached ~20s per network+address
   */
  async getAccountInfo(address: string): Promise<AccountInfo> {
    this.log.debug("Fetching account info", { address });
    const key = cacheKey(["account", this.network, address]);
    return withCache(key, CACHE_TTL_BALANCE_MS, () =>
      this.fetchJson<AccountInfo>(`/v2/accounts/${address}?proof=0`, "fetch account info")
    );
  }

  /**
   * Get BNS names for an address (cached ~1h per network+address)
   */
  async getBnsNames(address: string): Promise<{ names: string[] }> {
    this.log.debug("Fetching BNS names", { address });
    const key = cacheKey(["bns", this.network, address]);
    return withCache(key, CACHE_TTL_BNS_MS, async () => {
      try {
        return await this.fetchJson<{ names: string[] }>(
          `/v1/addresses/stacks/${address}`,
          "fetch BNS names"
        );
      } catch (error) {
        if (error instanceof HiroError && error.status === 404) {
          return { names: [] };
        }
        throw error;
      }
    });
  }

  /**
   * Resolve BNS name to address
   */
  async resolveBnsName(name: string): Promise<{ address: string } | null> {
    this.log.debug("Resolving BNS name", { name });

    const parts = name.split(".");
    if (parts.length !== 2) {
      throw new HiroError("Invalid BNS name format", 400);
    }

    const [bnsName, namespace] = parts;

    try {
      const data = await this.fetchJson<BnsName>(
        `/v1/names/${bnsName}.${namespace}`,
        "resolve BNS"
      );
      return { address: data.owner };
    } catch (error) {
      if (error instanceof HiroError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get transaction
   */
  async getTransaction(txId: string): Promise<Transaction> {
    this.log.debug("Fetching transaction", { txId });

    const cleanTxId = txId.startsWith("0x") ? txId.slice(2) : txId;

    return this.fetchJson<Transaction>(`/extended/v1/tx/${cleanTxId}`, "fetch transaction");
  }

  /**
   * Get current block info (cached ~60s per network)
   */
  async getCurrentBlock(): Promise<BlockInfo> {
    this.log.debug("Fetching current block");
    const key = cacheKey(["block", this.network]);
    return withCache(key, CACHE_TTL_BLOCK_MS, async () => {
      const data = await this.fetchJson<{ results: BlockInfo[] }>(
        "/extended/v1/block?limit=1",
        "fetch current block"
      );
      if (!data.results || data.results.length === 0) {
        throw new HiroError("No blocks found", 500);
      }
      return data.results[0];
    });
  }

  /** Alias for issue #124 cache semantics */
  async getCurrentBlockHeight(): Promise<number> {
    const block = await this.getCurrentBlock();
    return block.height;
  }
}
