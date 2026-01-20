/**
 * Keccak-256 Implementation
 *
 * Standard Keccak-256 (not SHA-3), used by Ethereum and Clarity.
 */

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

/**
 * Compute Keccak-256 hash
 */
export function keccak256(data: Uint8Array): Uint8Array {
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
