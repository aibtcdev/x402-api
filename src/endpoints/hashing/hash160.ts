/**
 * Hash160 Endpoint
 *
 * Hash160 = RIPEMD160(SHA256(data))
 * Used for Bitcoin/Stacks addresses (P2PKH, P2SH).
 */

import { createHashingEndpoint } from "./base";
import { ripemd160 } from "./ripemd160-impl";

export const HashHash160 = createHashingEndpoint({
  algorithm: "Hash160",
  summary: "(paid, simple) Compute Hash160 (RIPEMD160(SHA256))",
  description: "Computes Hash160 (Clarity-compatible). Used for Bitcoin/Stacks addresses.",
  computeHash: async (input) => {
    const sha256Buffer = await crypto.subtle.digest("SHA-256", input);
    return ripemd160(new Uint8Array(sha256Buffer));
  },
});
