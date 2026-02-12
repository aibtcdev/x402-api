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
import { validateTokenType } from "../services/pricing";
import type { AppContext, TokenType, PricingTier } from "../types";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { StorageDO } from "../durable-objects/StorageDO";

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
   * Get the payer's address from the x402 v2 payment context
   * This is set by the x402 middleware after successful payment verification
   */
  protected getPayerAddress(c: AppContext): string | null {
    const x402Context = c.get("x402");
    if (x402Context?.payerAddress) {
      return x402Context.payerAddress;
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
