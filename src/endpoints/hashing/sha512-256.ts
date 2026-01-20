/**
 * SHA-512/256 Hash Endpoint
 *
 * SHA-512/256 is a truncated SHA-512 to 256 bits, used by Clarity.
 */

import { createHashingEndpoint } from "./base";

export const HashSha512_256 = createHashingEndpoint({
  algorithm: "SHA-512/256",
  summary: "(paid, simple) Compute SHA-512/256 hash",
  description: "Computes SHA-512/256 hash (Clarity-compatible). SHA-512 truncated to 256 bits.",
  computeHash: async (input) => {
    const hashBuffer = await crypto.subtle.digest("SHA-512", input);
    return new Uint8Array(hashBuffer).slice(0, 32);
  },
});
