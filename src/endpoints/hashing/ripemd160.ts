/**
 * RIPEMD-160 Hash Endpoint
 */

import { createHashingEndpoint } from "./base";
import { ripemd160 } from "./ripemd160-impl";

export const HashRipemd160 = createHashingEndpoint({
  algorithm: "RIPEMD-160",
  summary: "(paid, simple) Compute RIPEMD-160 hash",
  description: "Computes RIPEMD-160 hash (Clarity-compatible).",
  computeHash: (input) => ripemd160(input),
});
