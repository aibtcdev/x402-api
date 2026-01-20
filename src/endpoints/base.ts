/**
 * Base Endpoint Class
 *
 * All paid endpoints extend this class to get:
 * - Token type validation
 * - Payer address extraction
 * - Standardized error responses
 * - Pricing tier configuration
 */

import { OpenAPIRoute } from "chanfana";
import { Address, AddressVersion, deserializeTransaction } from "@stacks/transactions";
import { validateTokenType, getFixedTierEstimate } from "../services/pricing";
import type { AppContext, TokenType, PricingTier, PriceEstimate, SettlePaymentResult } from "../types";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { StorageDO } from "../durable-objects/StorageDO";
import type { UsageDO } from "../durable-objects/UsageDO";

// Extended settle result that may have sender in different formats
interface ExtendedSettleResult extends SettlePaymentResult {
  senderAddress?: string;
  sender_address?: string;
}

/**
 * Base class for all API endpoints
 */
export class BaseEndpoint extends OpenAPIRoute {
  /**
   * Pricing tier for this endpoint
   * Override in subclasses to set the tier
   */
  protected readonly pricingTier: PricingTier = "standard";

  /**
   * Get the token type from request (query param or header)
   */
  protected getTokenType(c: AppContext): TokenType {
    const rawTokenType =
      c.req.header("X-PAYMENT-TOKEN-TYPE") ||
      c.req.query("tokenType") ||
      "STX";
    return validateTokenType(rawTokenType);
  }

  /**
   * Get the price estimate for this endpoint
   */
  protected getPriceEstimate(c: AppContext): PriceEstimate {
    const tokenType = this.getTokenType(c);
    return getFixedTierEstimate(this.pricingTier, tokenType);
  }

  /**
   * Validate a Stacks address parameter
   * Returns normalized address or null if invalid
   */
  protected validateAddress(c: AppContext): string | null {
    const address = c.req.param("address");
    if (!address) return null;

    try {
      const addressObj = Address.parse(address);
      return Address.stringify(addressObj);
    } catch (e) {
      c.var.logger.warn("Invalid address format", { address, error: String(e) });
      return null;
    }
  }

  /**
   * Get the payer's address from the payment settlement result or signed transaction
   * This is set by the x402 middleware after successful payment verification
   */
  protected getPayerAddress(c: AppContext): string | null {
    const x402Context = c.get("x402");
    if (x402Context?.payerAddress) {
      return x402Context.payerAddress;
    }

    // Fallback to direct context values (for compatibility)
    const settleResult = c.get("settleResult") as ExtendedSettleResult | undefined;
    const signedTx = c.get("signedTx") as string | undefined;
    const network = c.env?.X402_NETWORK || "mainnet";

    // Try various fields from settle result first
    if (settleResult?.sender) {
      return settleResult.sender;
    }
    if (settleResult?.senderAddress) {
      return settleResult.senderAddress;
    }
    if (settleResult?.sender_address) {
      return settleResult.sender_address;
    }

    // Fallback: extract sender from signed transaction
    if (signedTx) {
      try {
        const hex = signedTx.startsWith("0x") ? signedTx.slice(2) : signedTx;
        const tx = deserializeTransaction(hex);

        if (tx.auth?.spendingCondition) {
          const spendingCondition = tx.auth.spendingCondition as {
            signer?: string;
            hashMode?: number;
          };

          if (spendingCondition.signer) {
            // Convert hash160 to address using the appropriate network
            const hash160 = spendingCondition.signer;
            const addressVersion = network === "mainnet"
              ? AddressVersion.MainnetSingleSig
              : AddressVersion.TestnetSingleSig;
            const address = Address.stringify({ hash160, version: addressVersion });
            return address;
          }
        }
      } catch (error) {
        c.var.logger.warn("Failed to extract sender from signed tx", { error: String(error) });
      }
    }

    return null;
  }

  /**
   * Return a standardized error response
   */
  protected errorResponse(
    c: AppContext,
    error: string,
    status: ContentfulStatusCode,
    extra: Record<string, unknown> = {}
  ): Response {
    const tokenType = this.getTokenType(c);
    return c.json(
      {
        ok: false,
        tokenType,
        error,
        ...extra,
      },
      status
    );
  }

  /**
   * Return a standardized success response
   */
  protected successResponse(
    c: AppContext,
    data: Record<string, unknown>
  ): Response {
    const tokenType = this.getTokenType(c);
    return c.json({
      ok: true,
      tokenType,
      ...data,
    });
  }

  /**
   * Get the Storage DO stub for the current payer
   * Returns null if no payer address available
   */
  protected getStorageDO(c: AppContext): DurableObjectStub<StorageDO> | null {
    const payerAddress = this.getPayerAddress(c);
    if (!payerAddress) {
      return null;
    }

    const id = c.env.STORAGE_DO.idFromName(payerAddress);
    return c.env.STORAGE_DO.get(id);
  }

  /**
   * Get the Usage DO stub for the current payer
   * Returns null if no payer address available
   */
  protected getUsageDO(c: AppContext): DurableObjectStub<UsageDO> | null {
    const payerAddress = this.getPayerAddress(c);
    if (!payerAddress) {
      return null;
    }

    const id = c.env.USAGE_DO.idFromName(payerAddress);
    return c.env.USAGE_DO.get(id);
  }
}

/**
 * Base class for free endpoints (no payment required)
 */
export class FreeEndpoint extends BaseEndpoint {
  protected readonly pricingTier: PricingTier = "free";
}

/**
 * Base class for standard paid endpoints (0.001 STX)
 */
export class StandardEndpoint extends BaseEndpoint {
  protected readonly pricingTier: PricingTier = "standard";
}

/**
 * Semantic aliases for StandardEndpoint
 *
 * All these aliases map to StandardEndpoint (0.001 STX pricing).
 * They exist for code clarity - making it obvious what type of
 * operation an endpoint performs without affecting actual pricing.
 *
 * Note: Despite the names suggesting different tiers, all paid
 * endpoints use the same "standard" pricing. Dynamic pricing is
 * only used for LLM endpoints that calculate cost based on tokens.
 */
export const SimpleEndpoint = StandardEndpoint;
export const AIEndpoint = StandardEndpoint;
export const StorageReadEndpoint = StandardEndpoint;
export const StorageWriteEndpoint = StandardEndpoint;
export const StorageWriteLargeEndpoint = StandardEndpoint;
