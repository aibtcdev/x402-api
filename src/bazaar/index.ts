/**
 * Bazaar Extension - Public API
 *
 * Exports types, registry, and helper functions for Coinbase x402 Bazaar
 * discovery metadata integration.
 */

// Re-export types
export type {
  BazaarInputHttp,
  BazaarOutputJson,
  BazaarInfo,
  BazaarSchema,
  BazaarExtension,
  EndpointMetadata,
} from "./types";

// Re-export registry and utilities
export {
  ENDPOINT_METADATA_REGISTRY,
  getEndpointMetadata,
  getEndpointsByCategory,
  REGISTRY_STATS,
} from "./registry";

import type { EndpointMetadata, BazaarExtension } from "./types";

/**
 * Build a complete Bazaar extension from endpoint metadata
 *
 * Constructs the full Bazaar discovery extension object with:
 * - info: Input/output specification
 * - schema: JSON Schema validator
 *
 * @param metadata - Endpoint metadata from registry
 * @returns Complete Bazaar extension object
 */
export function buildBazaarExtension(metadata: EndpointMetadata): BazaarExtension {
  // Build input specification
  const input = {
    type: "http" as const,
    method: metadata.method,
    ...(metadata.queryParams ? { queryParams: metadata.queryParams } : {}),
    ...(metadata.bodyType ? { bodyType: metadata.bodyType } : {}),
  };

  // Build output specification
  const output = {
    type: "json" as const,
    example: metadata.outputExample,
  };

  // Build info structure
  const info = {
    input,
    output,
  };

  // Build JSON Schema validator
  const schema: BazaarExtension["bazaar"]["schema"] = {
    $schema: "https://json-schema.org/draft/2020-12/schema" as const,
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

  return {
    bazaar: {
      info,
      schema,
    },
  };
}

/**
 * Helper to extract query parameter schema from metadata
 */
export function extractQueryParamsSchema(metadata: EndpointMetadata): Record<string, unknown> | undefined {
  return metadata.queryParams;
}

/**
 * Helper to extract request body schema from metadata
 */
export function extractBodySchema(metadata: EndpointMetadata): Record<string, unknown> | undefined {
  return metadata.bodySchema;
}
