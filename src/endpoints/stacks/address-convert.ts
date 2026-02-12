/**
 * Address Convert Endpoint
 *
 * Converts a Stacks address between mainnet and testnet formats.
 */

import { SimpleEndpoint } from "../base";
import { tokenTypeParam, response400, response402 } from "../schema";
import { Address, AddressVersion } from "@stacks/transactions";
import type { AppContext } from "../../types";

export class AddressConvert extends SimpleEndpoint {
  schema = {
    tags: ["Stacks"],
    summary: "(paid, simple) Convert Stacks address between networks",
    description: "Converts a Stacks address from mainnet to testnet or vice versa.",
    parameters: [
      {
        name: "address",
        in: "path" as const,
        required: true,
        schema: { type: "string" as const },
        description: "Stacks address to convert",
      },
      {
        name: "targetNetwork",
        in: "query" as const,
        required: false,
        schema: {
          type: "string" as const,
          enum: ["mainnet", "testnet"],
          default: "testnet",
        },
        description: "Target network for conversion",
      },
      tokenTypeParam,
    ],
    responses: {
      "200": {
        description: "Converted address",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                ok: { type: "boolean" as const },
                original: { type: "string" as const },
                converted: { type: "string" as const },
                originalNetwork: { type: "string" as const },
                targetNetwork: { type: "string" as const },
                tokenType: { type: "string" as const },
              },
            },
          },
        },
      },
      "400": response400,
      "402": response402,
    },
  };

  async handle(c: AppContext) {
    const tokenType = this.getTokenType(c);
    const address = c.req.param("address");
    const targetNetwork = (c.req.query("targetNetwork") || "testnet") as "mainnet" | "testnet";

    if (!address) {
      return this.errorResponse(c, "address parameter is required", 400);
    }

    try {
      // Parse the address to get its components
      const addressObj = Address.parse(address);

      // Determine original network based on prefix
      const isMainnet = address.startsWith("SP") || address.startsWith("SM");
      const originalNetwork = isMainnet ? "mainnet" : "testnet";

      // Determine if P2PKH based on address prefix (SP/ST = single sig, SM/SN = multisig)
      const isP2PKH = address.startsWith("SP") || address.startsWith("ST");

      // Convert to target network using AddressVersion enum
      let convertedVersion: AddressVersion;
      if (targetNetwork === "mainnet") {
        convertedVersion = isP2PKH ? AddressVersion.MainnetSingleSig : AddressVersion.MainnetMultiSig;
      } else {
        convertedVersion = isP2PKH ? AddressVersion.TestnetSingleSig : AddressVersion.TestnetMultiSig;
      }

      const convertedAddress = Address.stringify({
        hash160: addressObj.hash160,
        version: convertedVersion,
      });

      return c.json({
        ok: true,
        original: address,
        converted: convertedAddress,
        originalNetwork,
        targetNetwork,
        tokenType,
      });
    } catch (error) {
      return this.errorResponse(c, "Invalid Stacks address format", 400);
    }
  }
}
