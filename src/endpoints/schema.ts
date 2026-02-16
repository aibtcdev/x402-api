/**
 * Shared Schema Definitions
 *
 * Common OpenAPI schema components used across endpoints to reduce duplication.
 */

// =============================================================================
// Common Parameters
// =============================================================================

/**
 * Token type query parameter (STX, sBTC, USDCx)
 * Used by all paid endpoints to specify payment token
 */
export const tokenTypeParam = {
  name: "tokenType",
  in: "query" as const,
  required: false,
  schema: { type: "string" as const, enum: ["STX", "sBTC", "USDCx"], default: "STX" },
  description: "Payment token type",
};

// =============================================================================
// Common Response Schemas
// =============================================================================

/** Standard 402 Payment Required response */
export const response402 = { description: "Payment required" };

/** Standard 400 Bad Request response */
export const response400 = { description: "Invalid request" };

// =============================================================================
// Common Property Schemas
// =============================================================================

/** ok: boolean property */
export const okProp = { type: "boolean" as const };

/** tokenType: string property */
export const tokenTypeProp = { type: "string" as const };

/** string property */
export const stringProp = { type: "string" as const };

/** boolean property */
export const boolProp = { type: "boolean" as const };

/** integer property */
export const intProp = { type: "integer" as const };

/** object property */
export const objectProp = { type: "object" as const };

// =============================================================================
// Parameter Builders
// =============================================================================

/**
 * Create a path parameter
 */
export function pathParam(name: string, description: string) {
  return {
    name,
    in: "path" as const,
    required: true,
    schema: stringProp,
    description,
  };
}

/**
 * Create an optional string query parameter
 */
export function queryParamString(name: string, description: string) {
  return {
    name,
    in: "query" as const,
    required: false,
    schema: { type: "string" as const },
    description,
  };
}

/**
 * Create an optional integer query parameter with default
 */
export function queryParamInt(name: string, description: string, defaultValue: number) {
  return {
    name,
    in: "query" as const,
    required: false,
    schema: { type: "integer" as const, default: defaultValue },
    description,
  };
}
