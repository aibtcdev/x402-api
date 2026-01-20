/**
 * SHA-256 Hash Endpoint
 */

import { createHashingEndpoint } from "./base";

export const HashSha256 = createHashingEndpoint({
  algorithm: "SHA-256",
  summary: "(paid, simple) Compute SHA-256 hash",
  description: "Computes SHA-256 hash using SubtleCrypto. Clarity-compatible output.",
  computeHash: async (input) => {
    const hashBuffer = await crypto.subtle.digest("SHA-256", input);
    return new Uint8Array(hashBuffer);
  },
});
