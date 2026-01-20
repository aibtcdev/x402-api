/**
 * Encoding Utilities
 *
 * Shared functions for hex/bytes/base64 conversions used across endpoints.
 */

/**
 * Convert a hex string (with optional 0x prefix) to Uint8Array
 */
export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
  const matches = cleanHex.match(/.{1,2}/g);
  if (!matches) return new Uint8Array(0);
  return new Uint8Array(matches.map((byte) => parseInt(byte, 16)));
}

/**
 * Convert a Uint8Array to hex string (without 0x prefix)
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Convert a Uint8Array to base64 string
 */
export function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Parse input data - handles both hex (0x prefixed) and text input
 * Returns the data as Uint8Array for processing
 */
export function parseInputData(data: string): Uint8Array {
  if (data.startsWith("0x")) {
    return hexToBytes(data);
  }
  return new TextEncoder().encode(data);
}

/**
 * Encode bytes to the specified output format
 */
export function encodeOutput(bytes: Uint8Array, encoding: "hex" | "base64"): string {
  if (encoding === "base64") {
    return bytesToBase64(bytes);
  }
  return `0x${bytesToHex(bytes)}`;
}
