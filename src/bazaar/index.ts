/**
 * Bazaar Extension - Public API
 *
 * Exports types, registry, and helper functions for Coinbase x402 Bazaar
 * discovery metadata integration.
 */

// Re-export types
export type { BazaarExtension, EndpointMetadata } from "./types";

// Re-export registry and utilities
export { getEndpointMetadata } from "./registry";

import type { EndpointMetadata, BazaarExtension } from "./types";

/**
 * Static JSON Schema validator for the Bazaar info structure.
 * This schema validates the shape of the info object (input/output),
 * not the endpoint's data -- so it is the same for every endpoint.
 */
const BAZAAR_INFO_SCHEMA: BazaarExtension["bazaar"]["schema"] = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    input: {
      type: "object",
      properties: {
        type: { type: "string", const: "http" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        queryParams: { type: "object" },
        bodyType: { type: "string", enum: ["json", "form", "text", "binary"] },
      },
      required: ["type", "method"],
    },
    output: {
      type: "object",
      properties: {
        type: { type: "string", const: "json" },
        example: { type: "object" },
      },
      required: ["type", "example"],
    },
  },
  required: ["input", "output"],
};

/**
 * Build a complete Bazaar extension from endpoint metadata
 */
export function buildBazaarExtension(metadata: EndpointMetadata): BazaarExtension {
  return {
    bazaar: {
      info: {
        input: {
          type: "http",
          method: metadata.method,
          ...(metadata.queryParams && { queryParams: metadata.queryParams }),
          ...(metadata.bodyType && { bodyType: metadata.bodyType }),
          ...(metadata.bodySchema && { bodySchema: metadata.bodySchema }),
        },
        output: {
          type: "json",
          example: metadata.outputExample,
          ...(metadata.outputSchema && { schema: metadata.outputSchema }),
        },
      },
      schema: BAZAAR_INFO_SCHEMA,
    },
  };
}
