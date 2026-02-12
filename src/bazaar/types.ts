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
 * HTTP input specification for an endpoint
 */
export interface BazaarInputHttp {
  type: "http";
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  queryParams?: Record<string, unknown>; // JSON Schema properties
  bodyType?: "json" | "form" | "text" | "binary";
}

/**
 * JSON output specification for an endpoint
 */
export interface BazaarOutputJson {
  type: "json";
  example: Record<string, unknown>; // Realistic response data
}

/**
 * Discovery metadata info structure
 */
export interface BazaarInfo {
  input: BazaarInputHttp;
  output: BazaarOutputJson;
}

/**
 * JSON Schema validator for the info structure
 */
export interface BazaarSchema {
  $schema: "https://json-schema.org/draft/2020-12/schema";
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/**
 * Complete Bazaar extension object
 */
export interface BazaarExtension {
  bazaar: {
    info: BazaarInfo;
    schema: BazaarSchema;
  };
}

/**
 * Endpoint metadata for registry
 */
export interface EndpointMetadata {
  path: string; // e.g., "/hashing/sha256"
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  category: string; // e.g., "hashing", "stacks", "storage"
  description: string;
  // Input specification
  queryParams?: Record<string, unknown>; // JSON Schema for query params
  bodySchema?: Record<string, unknown>; // JSON Schema for request body
  bodyType?: "json" | "form" | "text" | "binary";
  // Output specification
  outputExample: Record<string, unknown>; // Realistic example response
  outputSchema?: Record<string, unknown>; // JSON Schema for response
}
