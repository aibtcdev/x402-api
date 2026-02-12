/**
 * Verify Message Endpoint
 *
 * Verifies a signed message using Stacks signatures.
 */

import { SimpleEndpoint } from "../base";
import { tokenTypeParam, response400, response402 } from "../schema";
import { stripHexPrefix } from "../../utils/encoding";
import { verifyMessageSignatureRsv } from "@stacks/encryption";
import type { AppContext } from "../../types";

export class VerifyMessage extends SimpleEndpoint {
  schema = {
    tags: ["Stacks"],
    summary: "(paid, simple) Verify a signed message",
    description: "Verifies that a message was signed by a specific Stacks address.",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["message", "signature", "publicKey"],
            properties: {
              message: {
                type: "string" as const,
                description: "The original message that was signed",
              },
              signature: {
                type: "string" as const,
                description: "The signature in hex format",
              },
              publicKey: {
                type: "string" as const,
                description: "The public key in hex format",
              },
            },
          },
        },
      },
    },
    parameters: [tokenTypeParam],
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

    const body = await this.parseBody<{ message?: string; signature?: string; publicKey?: string }>(c);
    if (body instanceof Response) return body;

    const { message, signature, publicKey } = body;

    if (!message || typeof message !== "string") {
      return this.errorResponse(c, "message is required", 400);
    }
    if (!signature || typeof signature !== "string") {
      return this.errorResponse(c, "signature is required", 400);
    }
    if (!publicKey || typeof publicKey !== "string") {
      return this.errorResponse(c, "publicKey is required", 400);
    }

    try {
      // Normalize signature (remove 0x prefix if present)
      const cleanSig = stripHexPrefix(signature);
      const cleanPubKey = stripHexPrefix(publicKey);

      // Verify the signature
      let valid: boolean;
      try {
        valid = verifyMessageSignatureRsv({
          message,
          signature: cleanSig,
          publicKey: cleanPubKey,
        });
      } catch (cryptoError) {
        // Cryptographic validation errors (invalid signature format, invalid pubkey, etc.)
        // are treated as invalid signatures rather than API errors
        c.var.logger.debug("Signature cryptographically invalid", { error: String(cryptoError) });
        valid = false;
      }

      return c.json({
        ok: true,
        valid,
        message: valid ? "Signature is valid" : "Signature is invalid",
        tokenType,
      });
    } catch (error) {
      c.var.logger.warn("Signature verification error", { error: String(error) });
      return this.errorResponse(c, `Verification failed: ${error instanceof Error ? error.message : String(error)}`, 400);
    }
  }
}
