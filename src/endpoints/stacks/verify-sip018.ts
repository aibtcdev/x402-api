/**
 * Verify SIP-018 Endpoint
 *
 * Verifies SIP-018 structured data signatures.
 * SIP-018 is used for signing structured data on Stacks (meta-tx, permits, voting).
 */

import { SimpleEndpoint } from "../base";
import {
  verifyMessageSignatureRsv,
} from "@stacks/encryption";
import {
  serializeCV,
  tupleCV,
  stringAsciiCV,
  uintCV,
} from "@stacks/transactions";
import type { AppContext } from "../../types";

// SIP-018 domain tuple structure
interface SIP018Domain {
  name: string;
  version: string;
  chainId: number;
}

export class VerifySIP018 extends SimpleEndpoint {
  schema = {
    tags: ["Stacks"],
    summary: "(paid, simple) Verify SIP-018 structured data signature",
    description: "Verifies a signature created using SIP-018 structured data signing standard.",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["signature", "publicKey", "domain", "message"],
            properties: {
              signature: {
                type: "string" as const,
                description: "The signature in hex format",
              },
              publicKey: {
                type: "string" as const,
                description: "The public key in hex format",
              },
              domain: {
                type: "object" as const,
                required: ["name", "version", "chainId"],
                properties: {
                  name: { type: "string" as const, description: "Domain name" },
                  version: { type: "string" as const, description: "Domain version" },
                  chainId: { type: "integer" as const, description: "Chain ID (1 for mainnet, 2147483648 for testnet)" },
                },
              },
              message: {
                type: "string" as const,
                description: "The message hex (serialized Clarity value)",
              },
            },
          },
        },
      },
    },
    parameters: [
      {
        name: "tokenType",
        in: "query" as const,
        required: false,
        schema: {
          type: "string" as const,
          enum: ["STX", "sBTC", "USDCx"],
          default: "STX",
        },
      },
    ],
    responses: {
      "200": {
        description: "Verification result",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                ok: { type: "boolean" as const },
                valid: { type: "boolean" as const },
                message: { type: "string" as const },
                structuredDataHash: { type: "string" as const },
                tokenType: { type: "string" as const },
              },
            },
          },
        },
      },
      "400": { description: "Invalid input" },
      "402": { description: "Payment required" },
    },
  };

  async handle(c: AppContext) {
    const tokenType = this.getTokenType(c);

    let body: {
      signature?: string;
      publicKey?: string;
      domain?: SIP018Domain;
      message?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return this.errorResponse(c, "Invalid JSON body", 400);
    }

    const { signature, publicKey, domain, message } = body;

    if (!signature || typeof signature !== "string") {
      return this.errorResponse(c, "signature is required", 400);
    }
    if (!publicKey || typeof publicKey !== "string") {
      return this.errorResponse(c, "publicKey is required", 400);
    }
    if (!domain || typeof domain !== "object") {
      return this.errorResponse(c, "domain object is required", 400);
    }
    if (!domain.name || !domain.version || domain.chainId === undefined) {
      return this.errorResponse(c, "domain must have name, version, and chainId", 400);
    }
    if (!message || typeof message !== "string") {
      return this.errorResponse(c, "message is required", 400);
    }

    try {
      // Normalize hex values
      const cleanSig = signature.startsWith("0x") ? signature.slice(2) : signature;
      const cleanPubKey = publicKey.startsWith("0x") ? publicKey.slice(2) : publicKey;
      const cleanMessage = message.startsWith("0x") ? message.slice(2) : message;

      // Construct SIP-018 domain tuple
      const domainTuple = tupleCV({
        name: stringAsciiCV(domain.name),
        version: stringAsciiCV(domain.version),
        "chain-id": uintCV(domain.chainId),
      });

      // Serialize domain
      const domainSerialized = serializeCV(domainTuple);

      // Combine domain and message for structured data hash
      // SIP-018 format: 0x534950303138 (SIP018 prefix) + domain + message
      const sip018Prefix = "534950303138"; // "SIP018" in ASCII hex
      const structuredDataHex = sip018Prefix +
        Buffer.from(domainSerialized).toString("hex") +
        cleanMessage;

      // Hash the structured data
      const structuredDataBytes = Buffer.from(structuredDataHex, "hex");
      const hashBuffer = await crypto.subtle.digest("SHA-256", structuredDataBytes);
      const structuredDataHash = Buffer.from(hashBuffer).toString("hex");

      // The actual signed message is the hash
      // Verify the signature against this hash
      const valid = verifyMessageSignatureRsv({
        message: structuredDataHash,
        signature: cleanSig,
        publicKey: cleanPubKey,
      });

      return c.json({
        ok: true,
        valid,
        message: valid ? "SIP-018 signature is valid" : "SIP-018 signature is invalid",
        structuredDataHash: `0x${structuredDataHash}`,
        tokenType,
      });
    } catch (error) {
      c.var.logger.warn("SIP-018 verification error", { error: String(error) });
      return this.errorResponse(c, `Verification failed: ${error instanceof Error ? error.message : String(error)}`, 400);
    }
  }
}
