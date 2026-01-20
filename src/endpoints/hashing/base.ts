/**
 * Hashing Endpoint Base
 *
 * Factory function to create hashing endpoint classes with shared
 * schema, validation, and response logic.
 */

import { SimpleEndpoint } from "../base";
import { parseInputData, encodeOutput } from "../../utils/encoding";
import type { AppContext } from "../../types";

/**
 * Configuration for creating a hashing endpoint
 */
export interface HashingEndpointConfig {
  /** Algorithm name (e.g., "SHA-256") - used in response */
  algorithm: string;
  /** Summary for OpenAPI schema */
  summary: string;
  /** Description for OpenAPI schema */
  description: string;
  /** Function to compute the hash */
  computeHash: (input: Uint8Array) => Promise<Uint8Array> | Uint8Array;
}

/**
 * Creates a hashing endpoint class with the given configuration
 */
export function createHashingEndpoint(config: HashingEndpointConfig) {
  return class extends SimpleEndpoint {
    schema = {
      tags: ["Hashing"],
      summary: config.summary,
      description: config.description,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              required: ["data"],
              properties: {
                data: {
                  type: "string" as const,
                  description: "Data to hash (text or hex with 0x prefix)",
                },
                encoding: {
                  type: "string" as const,
                  enum: ["hex", "base64"],
                  default: "hex",
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
          description: `${config.algorithm} hash`,
          content: {
            "application/json": {
              schema: {
                type: "object" as const,
                properties: {
                  ok: { type: "boolean" as const },
                  hash: { type: "string" as const },
                  algorithm: { type: "string" as const },
                  encoding: { type: "string" as const },
                  inputLength: { type: "integer" as const },
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

      let body: { data?: string; encoding?: string };
      try {
        body = await c.req.json();
      } catch {
        return this.errorResponse(c, "Invalid JSON body", 400);
      }

      const { data, encoding = "hex" } = body;

      if (!data || typeof data !== "string") {
        return this.errorResponse(c, "data field is required", 400);
      }

      if (encoding !== "hex" && encoding !== "base64") {
        return this.errorResponse(c, "encoding must be 'hex' or 'base64'", 400);
      }

      const inputBytes = parseInputData(data);
      const hashBytes = await config.computeHash(inputBytes);
      const hash = encodeOutput(hashBytes, encoding);

      return c.json({
        ok: true,
        hash,
        algorithm: config.algorithm,
        encoding,
        inputLength: inputBytes.length,
        tokenType,
      });
    }
  };
}
