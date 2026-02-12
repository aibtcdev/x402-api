/**
 * Bazaar Extension Types
 *
 * TypeScript interfaces for the Coinbase x402 Bazaar discovery extension.
 * Implements the discovery metadata format natively (not using @x402/extensions
 * since it depends on @x402/core which is EVM-focused).
 *
 * @see https://docs.cdp.coinbase.com/x402/bazaar
 */

/**
 * Complete Bazaar extension object attached to 402 responses
 */
export interface BazaarExtension {
  bazaar: {
    info: {
      input: {
        type: "http";
        method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
        queryParams?: Record<string, unknown>;
        bodyType?: "json" | "form" | "text" | "binary";
        bodySchema?: Record<string, unknown>;
      };
      output: {
        type: "json";
        example: Record<string, unknown>;
        schema?: Record<string, unknown>;
      };
    };
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema";
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
}

/**
 * Endpoint metadata for registry
 */
export interface EndpointMetadata {
  path: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  category: string;
  description: string;
  queryParams?: Record<string, unknown>;
  bodySchema?: Record<string, unknown>;
  bodyType?: "json" | "form" | "text" | "binary";
  outputExample: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}
