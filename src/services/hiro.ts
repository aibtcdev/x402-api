/**
 * Hiro API Service
 *
 * Client for the Hiro Stacks API.
 * https://docs.hiro.so/stacks/api
 */

import type { Logger } from "../types";

// =============================================================================
// Constants
// =============================================================================

const HIRO_API_BASE = "https://api.hiro.so";

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

export interface AccountNonces {
  last_mempool_tx_nonce: number | null;
  last_executed_tx_nonce: number | null;
  possible_next_nonce: number;
  detected_missing_nonces: number[];
  detected_mempool_nonces?: number[];
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

// =============================================================================
// Hiro Client
// =============================================================================

export class HiroClient {
  private apiKey?: string;
  private log: Logger;
  private network: "mainnet" | "testnet";

  constructor(logger: Logger, network: "mainnet" | "testnet" = "mainnet", apiKey?: string) {
    this.log = logger;
    this.network = network;
    this.apiKey = apiKey;
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

  /**
   * Get account balance
   */
  async getAccountBalance(address: string): Promise<AccountBalance> {
    this.log.debug("Fetching account balance", { address });

    const response = await fetch(
      `${this.baseUrl}/extended/v1/address/${address}/balances`,
      { headers: this.getHeaders() }
    );

    if (!response.ok) {
      const error = await response.text();
      this.log.error("Failed to fetch account balance", { address, error });
      throw new HiroError(`Failed to fetch balance: ${response.status}`, response.status);
    }

    return response.json() as Promise<AccountBalance>;
  }

  /**
   * Get account info (nonce, balance)
   */
  async getAccountInfo(address: string): Promise<AccountInfo> {
    this.log.debug("Fetching account info", { address });

    const response = await fetch(
      `${this.baseUrl}/v2/accounts/${address}?proof=0`,
      { headers: this.getHeaders() }
    );

    if (!response.ok) {
      const error = await response.text();
      this.log.error("Failed to fetch account info", { address, error });
      throw new HiroError(`Failed to fetch account info: ${response.status}`, response.status);
    }

    return response.json() as Promise<AccountInfo>;
  }

  /**
   * Get account nonce tracking state (`possible_next_nonce`, `last_executed_tx_nonce`,
   * `last_mempool_tx_nonce`, `detected_missing_nonces`, `detected_mempool_nonces`).
   */
  async getAccountNonces(address: string, signal?: AbortSignal): Promise<AccountNonces> {
    this.log.debug("Fetching account nonces", { address });

    const response = await fetch(
      `${this.baseUrl}/extended/v1/address/${address}/nonces`,
      { headers: this.getHeaders(), ...(signal ? { signal } : {}) }
    );

    if (!response.ok) {
      const error = await response.text();
      this.log.error("Failed to fetch account nonces", { address, error });
      throw new HiroError(`Failed to fetch account nonces: ${response.status}`, response.status);
    }

    return response.json() as Promise<AccountNonces>;
  }

  /**
   * Look up an anchored transaction sent by `address` at a specific `nonce`
   * (`GET /extended/v1/tx?from_address={address}&nonce={nonce}&limit=1`).
   * Indexed by `(from_address, nonce)` on Hiro so busy addresses with >50 newer
   * transactions still resolve their anchored tx in one request.
   */
  async getTransactionBySenderNonce(
    address: string,
    nonce: number,
    signal?: AbortSignal
  ): Promise<Transaction | null> {
    this.log.debug("Fetching transaction by sender and nonce", { address, nonce });

    const encodedAddress = encodeURIComponent(address);
    const response = await fetch(
      `${this.baseUrl}/extended/v1/tx?from_address=${encodedAddress}&nonce=${nonce}&limit=1`,
      { headers: this.getHeaders(), ...(signal ? { signal } : {}) }
    );

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      const error = await response.text();
      this.log.error("Failed to fetch transaction by sender nonce", { address, nonce, error });
      throw new HiroError(
        `Failed to fetch transaction by sender nonce: ${response.status}`,
        response.status
      );
    }

    const data = (await response.json()) as { results?: Transaction[] };
    const results = Array.isArray(data.results) ? data.results : [];
    const match = results.find(
      (t) =>
        t.sender_address === address &&
        Number(t.nonce) === nonce &&
        t.canonical !== false
    );
    return match ?? null;
  }

  /**
   * Get recent anchored transactions for an address.
   */
  async getAddressTransactions(
    address: string,
    limit = 50,
    signal?: AbortSignal
  ): Promise<Transaction[]> {
    this.log.debug("Fetching address transactions", { address, limit });

    const response = await fetch(
      `${this.baseUrl}/extended/v1/address/${address}/transactions?limit=${limit}`,
      { headers: this.getHeaders(), ...(signal ? { signal } : {}) }
    );

    if (!response.ok) {
      const error = await response.text();
      this.log.error("Failed to fetch address transactions", { address, error });
      throw new HiroError(
        `Failed to fetch address transactions: ${response.status}`,
        response.status
      );
    }

    const data = (await response.json()) as { results?: Transaction[] };
    return Array.isArray(data.results) ? data.results : [];
  }

  /**
   * Get raw serialized hex (`0x...` or bare hex) for a transaction ID.
   */
  async getRawTransactionHex(txId: string, signal?: AbortSignal): Promise<string> {
    this.log.debug("Fetching raw transaction", { txId });

    const cleanTxId = txId.startsWith("0x") ? txId.slice(2) : txId;

    const response = await fetch(
      `${this.baseUrl}/extended/v1/tx/${cleanTxId}/raw`,
      { headers: this.getHeaders(), ...(signal ? { signal } : {}) }
    );

    if (!response.ok) {
      const error = await response.text();
      this.log.error("Failed to fetch raw transaction", { txId, error });
      throw new HiroError(`Failed to fetch raw transaction: ${response.status}`, response.status);
    }

    const data = (await response.json()) as { raw_tx?: string };
    if (typeof data.raw_tx !== "string" || data.raw_tx.length === 0) {
      throw new HiroError("Missing raw_tx in Hiro response", 502);
    }
    return data.raw_tx;
  }

  /**
   * Get BNS names for an address
   */
  async getBnsNames(address: string): Promise<{ names: string[] }> {
    this.log.debug("Fetching BNS names", { address });

    const response = await fetch(
      `${this.baseUrl}/v1/addresses/stacks/${address}`,
      { headers: this.getHeaders() }
    );

    if (!response.ok) {
      // 404 means no names
      if (response.status === 404) {
        return { names: [] };
      }
      const error = await response.text();
      this.log.error("Failed to fetch BNS names", { address, error });
      throw new HiroError(`Failed to fetch BNS names: ${response.status}`, response.status);
    }

    return response.json() as Promise<{ names: string[] }>;
  }

  /**
   * Resolve BNS name to address
   */
  async resolveBnsName(name: string): Promise<{ address: string } | null> {
    this.log.debug("Resolving BNS name", { name });

    // Parse name (e.g., "satoshi.btc" -> name="satoshi", namespace="btc")
    const parts = name.split(".");
    if (parts.length !== 2) {
      throw new HiroError("Invalid BNS name format", 400);
    }

    const [bnsName, namespace] = parts;

    const response = await fetch(
      `${this.baseUrl}/v1/names/${bnsName}.${namespace}`,
      { headers: this.getHeaders() }
    );

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      const error = await response.text();
      this.log.error("Failed to resolve BNS name", { name, error });
      throw new HiroError(`Failed to resolve BNS: ${response.status}`, response.status);
    }

    const data = (await response.json()) as BnsName;
    return { address: data.owner };
  }

  /**
   * Get transaction
   */
  async getTransaction(txId: string): Promise<Transaction> {
    this.log.debug("Fetching transaction", { txId });

    // Remove 0x prefix if present
    const cleanTxId = txId.startsWith("0x") ? txId.slice(2) : txId;

    const response = await fetch(
      `${this.baseUrl}/extended/v1/tx/${cleanTxId}`,
      { headers: this.getHeaders() }
    );

    if (!response.ok) {
      const error = await response.text();
      this.log.error("Failed to fetch transaction", { txId, error });
      throw new HiroError(`Failed to fetch transaction: ${response.status}`, response.status);
    }

    return response.json() as Promise<Transaction>;
  }

  /**
   * Get current block info
   */
  async getCurrentBlock(): Promise<BlockInfo> {
    this.log.debug("Fetching current block");

    const response = await fetch(
      `${this.baseUrl}/extended/v1/block?limit=1`,
      { headers: this.getHeaders() }
    );

    if (!response.ok) {
      const error = await response.text();
      this.log.error("Failed to fetch current block", { error });
      throw new HiroError(`Failed to fetch block: ${response.status}`, response.status);
    }

    const data = (await response.json()) as { results: BlockInfo[] };
    if (!data.results || data.results.length === 0) {
      throw new HiroError("No blocks found", 500);
    }

    return data.results[0];
  }
}

// =============================================================================
// Error Class
// =============================================================================

export class HiroError extends Error {
  public status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "HiroError";
    this.status = status;
  }
}
