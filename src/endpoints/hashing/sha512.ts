/**
 * SHA-512 Hash Endpoint
 */

import { createHashingEndpoint } from "./base";

export const HashSha512 = createHashingEndpoint({
  algorithm: "SHA-512",
  summary: "(paid, simple) Compute SHA-512 hash",
  description: "Computes SHA-512 hash using SubtleCrypto.",
  computeHash: async (input) => {
    const hashBuffer = await crypto.subtle.digest("SHA-512", input);
    return new Uint8Array(hashBuffer);
  },
});
