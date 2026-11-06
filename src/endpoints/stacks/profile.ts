/**
 * Stacks Profile Endpoint
 *
 * Gets a comprehensive profile for a Stacks address.
 */

import { SimpleEndpoint } from "../base";
import { tokenTypeParam, response400, response402 } from "../schema";
import { Address } from "@stacks/transactions";
import { HiroClient, HiroError } from "../../services/hiro";
import type { AppContext, StacksProfile } from "../../types";

/** Hiro rate limits are per minute; wait one window when Hiro sends no Retry-After. */
const HIRO_RATE_LIMIT_DEFAULT_RETRY_SECONDS = 60;

export class Profile extends SimpleEndpoint {
  schema = {
    tags: ["Stacks"],
    summary: "(paid, simple) Get Stacks address profile",
    description: "Returns a comprehensive profile including balances, BNS name, and token holdings.",
    parameters: [
      {
        name: "address",
        in: "path" as const,
        required: true,
        schema: { type: "string" as const },
        description: "Stacks address or BNS name (e.g., SP1234... or satoshi.btc)",
      },
      tokenTypeParam,
    ],
    responses: {
      "200": {
        description: "Address profile",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                ok: { type: "boolean" as const },
                profile: {
                  type: "object" as const,
                  properties: {
                    input: { type: "string" as const },
                    address: { type: "string" as const },
                    bnsName: { type: "string" as const },
                    blockHeight: { type: "integer" as const },
                    stxBalance: { type: "object" as const },
                    nonce: { type: "integer" as const },
                    fungibleTokens: { type: "array" as const },
                    nonFungibleTokens: { type: "array" as const },
                  },
                },
                tokenType: { type: "string" as const },
              },
            },
          },
        },
      },
      "400": response400,
      "402": response402,
      "404": { description: "Address not found" },
      "503": {
        description:
          "Upstream Stacks API (Hiro) is rate limiting. Retry after the Retry-After header (seconds); the body repeats it as retryAfter.",
      },
    },
  };

  async handle(c: AppContext) {
    const tokenType = this.getTokenType(c);
    const log = c.var.logger;
    const input = c.req.param("address");

    if (!input) {
      return this.errorResponse(c, "address parameter is required", 400);
    }

    const network = c.env.X402_NETWORK || "mainnet";
    const hiro = new HiroClient(log, network, c.env.HIRO_API_KEY);

    try {
      let address: string;
      let bnsName: string | undefined;

      // Check if input is a BNS name (contains a dot)
      if (input.includes(".")) {
        // Resolve BNS name
        const resolved = await hiro.resolveBnsName(input);
        if (!resolved) {
          return this.errorResponse(c, `BNS name '${input}' not found`, 404);
        }
        address = resolved.address;
        bnsName = input;
      } else {
        // Validate address format
        try {
          const parsed = Address.parse(input);
          address = Address.stringify(parsed);
        } catch {
          return this.errorResponse(c, "Invalid address format", 400);
        }

        // Look up BNS name for address
        try {
          const names = await hiro.getBnsNames(address);
          if (names.names.length > 0) {
            bnsName = names.names[0];
          }
        } catch {
          // BNS lookup failure is not critical
        }
      }

      // Get balance and account info
      const [balance, accountInfo, currentBlock] = await Promise.all([
        hiro.getAccountBalance(address),
        hiro.getAccountInfo(address),
        hiro.getCurrentBlock(),
      ]);

      // Process fungible tokens
      const fungibleTokens = Object.entries(balance.fungible_tokens || {}).map(
        ([contractId, token]) => ({
          contractId,
          balance: token.balance,
        })
      );

      // Process NFTs
      const nonFungibleTokens = Object.entries(balance.non_fungible_tokens || {}).map(
        ([contractId, token]) => ({
          contractId,
          count: parseInt(token.count, 10),
        })
      );

      const profile: StacksProfile = {
        input,
        address,
        bnsName,
        blockHeight: currentBlock.height,
        stxBalance: {
          balance: balance.stx.balance,
          locked: balance.stx.locked,
          unlockHeight: balance.stx.burnchain_unlock_height || undefined,
        },
        nonce: accountInfo.nonce,
        fungibleTokens,
        nonFungibleTokens,
      };

      return c.json({
        ok: true,
        profile,
        tokenType,
      });
    } catch (error) {
      if (error instanceof HiroError) {
        if (error.status === 404) {
          return this.errorResponse(c, "Address not found", 404);
        }
        if (error.status === 429) {
          // Upstream rate limit, not a server fault: answer 503 + Retry-After
          // (RFC 9110 sections 15.6.4 and 10.2.3) so clients back off instead of
          // retrying a 500 straight back into the same limit. Hiro's limits are
          // per minute (https://docs.hiro.so/resources/guides/rate-limits), so
          // without a Retry-After from Hiro, wait one window.
          const retryAfter = error.retryAfterSeconds ?? HIRO_RATE_LIMIT_DEFAULT_RETRY_SECONDS;
          log.warn("Hiro API rate limited", { error: error.message, retryAfter });
          c.header("Retry-After", String(retryAfter));
          return this.errorResponse(
            c,
            "Upstream Stacks API (Hiro) is rate limiting requests; retry later",
            503,
            { retryable: true, retryAfter }
          );
        }
        log.error("Hiro API error", { error: error.message, status: error.status });
        return this.errorResponse(c, `API error: ${error.message}`, error.status >= 500 ? 502 : 500);
      }

      log.error("Unexpected error fetching profile", { error: String(error) });
      return this.errorResponse(c, "Failed to fetch profile", 500);
    }
  }
}
