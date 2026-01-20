/**
 * Keccak-256 Hash Endpoint
 *
 * Keccak-256 is used by Ethereum and Clarity (keccak256 function).
 * Note: This uses the standard Keccak-256, not SHA-3.
 */

import { SimpleEndpoint } from "../base";
import { parseInputData, encodeOutput } from "../../utils/encoding";
import type { AppContext } from "../../types";

// Keccak-256 implementation (standard Keccak, not SHA-3)
function keccak256(data: Uint8Array): Uint8Array {
  // Keccak constants
  const ROUNDS = 24;
  const RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
    0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
    0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
    0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
    0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
    0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
    0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
  ];

  const ROTATIONS = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
  ];

  // Initialize state
  const state = new BigUint64Array(25);

  // Padding (Keccak padding: 0x01 + zeros + 0x80)
  const rate = 136; // 1088 bits = 136 bytes for Keccak-256
  const paddedLength = Math.ceil((data.length + 1) / rate) * rate;
  const padded = new Uint8Array(paddedLength);
  padded.set(data);
  padded[data.length] = 0x01;
  padded[paddedLength - 1] |= 0x80;

  // Absorb
  for (let i = 0; i < paddedLength; i += rate) {
    for (let j = 0; j < rate / 8; j++) {
      const offset = i + j * 8;
      let value = 0n;
      for (let k = 0; k < 8; k++) {
        value |= BigInt(padded[offset + k]) << BigInt(k * 8);
      }
      state[j] ^= value;
    }

    // Keccak-f[1600]
    for (let round = 0; round < ROUNDS; round++) {
      // θ step
      const C = new BigUint64Array(5);
      for (let x = 0; x < 5; x++) {
        C[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
      }
      const D = new BigUint64Array(5);
      for (let x = 0; x < 5; x++) {
        D[x] = C[(x + 4) % 5] ^ ((C[(x + 1) % 5] << 1n) | (C[(x + 1) % 5] >> 63n));
      }
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          state[x + y * 5] ^= D[x];
        }
      }

      // ρ and π steps
      const B = new BigUint64Array(25);
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          const r = ROTATIONS[x][y];
          const value = state[x + y * 5];
          B[y + ((2 * x + 3 * y) % 5) * 5] = (value << BigInt(r)) | (value >> BigInt(64 - r));
        }
      }

      // χ step
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          state[x + y * 5] = B[x + y * 5] ^ (~B[(x + 1) % 5 + y * 5] & B[(x + 2) % 5 + y * 5]);
        }
      }

      // ι step
      state[0] ^= RC[round];
    }
  }

  // Squeeze (256 bits = 32 bytes)
  const output = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    const value = state[i];
    for (let j = 0; j < 8; j++) {
      output[i * 8 + j] = Number((value >> BigInt(j * 8)) & 0xffn);
    }
  }

  return output;
}

export class HashKeccak256 extends SimpleEndpoint {
  schema = {
    tags: ["Hashing"],
    summary: "(paid, simple) Compute Keccak-256 hash",
    description: "Computes Keccak-256 hash (Clarity-compatible). Used by Ethereum and Stacks.",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["data"],
            properties: {
              data: {
                type: "string" as const,
                description: "Data to hash (text or hex with 0x prefix)",
              },
              encoding: {
                type: "string" as const,
                enum: ["hex", "base64"],
                default: "hex",
              },
            },
          },
        },
      },
    },
    parameters: [
      {
        name: "tokenType",
        in: "query" as const,
        required: false,
        schema: {
          type: "string" as const,
          enum: ["STX", "sBTC", "USDCx"],
          default: "STX",
        },
      },
    ],
    responses: {
      "200": {
        description: "Keccak-256 hash",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                ok: { type: "boolean" as const },
                hash: { type: "string" as const },
                algorithm: { type: "string" as const },
                encoding: { type: "string" as const },
                inputLength: { type: "integer" as const },
                tokenType: { type: "string" as const },
              },
            },
          },
        },
      },
      "400": { description: "Invalid input" },
      "402": { description: "Payment required" },
    },
  };

  async handle(c: AppContext) {
    const tokenType = this.getTokenType(c);

    let body: { data?: string; encoding?: string };
    try {
      body = await c.req.json();
    } catch {
      return this.errorResponse(c, "Invalid JSON body", 400);
    }

    const { data, encoding = "hex" } = body;

    if (!data || typeof data !== "string") {
      return this.errorResponse(c, "data field is required", 400);
    }

    if (encoding !== "hex" && encoding !== "base64") {
      return this.errorResponse(c, "encoding must be 'hex' or 'base64'", 400);
    }

    const inputBytes = parseInputData(data);
    const hash = encodeOutput(keccak256(inputBytes), encoding);

    return c.json({
      ok: true,
      hash,
      algorithm: "Keccak-256",
      encoding,
      inputLength: inputBytes.length,
      tokenType,
    });
  }
}
