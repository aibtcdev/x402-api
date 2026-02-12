/**
 * Decode Clarity Endpoint
 *
 * Decodes Clarity hex values to human-readable format.
 */

import { SimpleEndpoint } from "../base";
import { tokenTypeParam, response400, response402 } from "../schema";
import { stripHexPrefix } from "../../utils/encoding";
import { cvToJSON, hexToCV, ClarityType } from "@stacks/transactions";
import type { AppContext } from "../../types";
import type { ClarityValue } from "@stacks/transactions";

export class DecodeClarity extends SimpleEndpoint {
  schema = {
    tags: ["Stacks"],
    summary: "(paid, simple) Decode Clarity hex value",
    description: "Decodes a Clarity value from its hex representation to JSON.",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["hex"],
            properties: {
              hex: {
                type: "string" as const,
                description: "Clarity value in hex format (with or without 0x prefix)",
              },
            },
          },
        },
      },
    },
    parameters: [tokenTypeParam],
    responses: {
      "200": {
        description: "Decoded Clarity value",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                ok: { type: "boolean" as const },
                hex: { type: "string" as const },
                type: { type: "string" as const },
                value: { type: "object" as const },
                repr: { type: "string" as const },
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

    const body = await this.parseBody<{ hex?: string }>(c);
    if (body instanceof Response) return body;

    const { hex } = body;
    if (!hex || typeof hex !== "string") {
      return this.errorResponse(c, "hex field is required", 400);
    }

    try {
      // Normalize hex (remove 0x prefix if present)
      const cleanHex = stripHexPrefix(hex);

      // Decode to Clarity Value
      const cv = hexToCV(cleanHex);
      const json = cvToJSON(cv);

      // Get type info
      const typeMap: Record<number, string> = {
        0: "int",
        1: "uint",
        2: "buffer",
        3: "bool-true",
        4: "bool-false",
        5: "principal-standard",
        6: "principal-contract",
        7: "response-ok",
        8: "response-err",
        9: "none",
        10: "some",
        11: "list",
        12: "tuple",
        13: "string-ascii",
        14: "string-utf8",
      };

      const cvWithType = cv as ClarityValue & { type: ClarityType };
      const cvType = cvWithType.type as unknown as number;
      const typeName = typeMap[cvType] ?? `unknown(${cvType})`;

      return c.json({
        ok: true,
        hex: `0x${cleanHex}`,
        type: typeName,
        value: json,
        repr: String(cv),
        tokenType,
      });
    } catch (error) {
      c.var.logger.warn("Failed to decode Clarity hex", {
        hex,
        error: String(error),
      });
      return this.errorResponse(c, `Failed to decode: ${error instanceof Error ? error.message : String(error)}`, 400);
    }
  }
}
