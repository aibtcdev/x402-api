/**
 * Keccak-256 Hash Endpoint
 *
 * Keccak-256 is used by Ethereum and Clarity (keccak256 function).
 * Note: This uses the standard Keccak-256, not SHA-3.
 */

import { createHashingEndpoint } from "./base";
import { keccak256 } from "./keccak256-impl";

export const HashKeccak256 = createHashingEndpoint({
  algorithm: "Keccak-256",
  summary: "(paid, simple) Compute Keccak-256 hash",
  description: "Computes Keccak-256 hash (Clarity-compatible). Used by Ethereum and Stacks.",
  computeHash: (input) => keccak256(input),
});
