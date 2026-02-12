/**
 * Decode Transaction Endpoint
 *
 * Decodes a serialized Stacks transaction.
 */

import { SimpleEndpoint } from "../base";
import { tokenTypeParam, response400, response402 } from "../schema";
import { stripHexPrefix } from "../../utils/encoding";
import {
  deserializeTransaction,
  AddressVersion,
  Address,
} from "@stacks/transactions";
import type { AppContext } from "../../types";

export class DecodeTransaction extends SimpleEndpoint {
  schema = {
    tags: ["Stacks"],
    summary: "(paid, simple) Decode a serialized Stacks transaction",
    description: "Decodes a serialized transaction and returns its components.",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["hex"],
            properties: {
              hex: {
                type: "string" as const,
                description: "Serialized transaction in hex format",
              },
            },
          },
        },
      },
    },
    parameters: [tokenTypeParam],
    responses: {
      "200": {
        description: "Decoded transaction",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                ok: { type: "boolean" as const },
                txType: { type: "string" as const },
                sender: { type: "string" as const },
                nonce: { type: "integer" as const },
                fee: { type: "string" as const },
                payload: { type: "object" as const },
                postConditions: { type: "array" as const },
                tokenType: { type: "string" as const },
              },
            },
          },
        },
      },
      "400": response400,
      "402": response402,
    },
  };

  async handle(c: AppContext) {
    const tokenType = this.getTokenType(c);

    const body = await this.parseBody<{ hex?: string }>(c);
    if (body instanceof Response) return body;

    const { hex } = body;
    if (!hex || typeof hex !== "string") {
      return this.errorResponse(c, "hex field is required", 400);
    }

    try {
      // Normalize hex
      const cleanHex = stripHexPrefix(hex);

      // Deserialize transaction
      const tx = deserializeTransaction(cleanHex);

      // Get transaction type name
      const txTypeMap: Record<number, string> = {
        0: "token_transfer",
        1: "smart_contract",
        2: "contract_call",
        3: "poison_microblock",
        4: "coinbase",
        5: "coinbase_to_alt_recipient",
        6: "versioned_smart_contract",
        7: "tenure_change",
        8: "nakamoto_coinbase",
      };

      // Use type assertion to access internal properties
      const txAny = tx as unknown as Record<string, unknown>;
      const payload = txAny.payload as Record<string, unknown> | undefined;
      const payloadType = payload?.payloadType as number | undefined;
      const txType = payloadType !== undefined ? txTypeMap[payloadType] || `unknown(${payloadType})` : "unknown";

      // Extract sender from auth
      let sender = "unknown";
      const auth = txAny.auth as Record<string, unknown> | undefined;
      const spendingCondition = auth?.spendingCondition as Record<string, unknown> | undefined;
      if (spendingCondition?.signer) {
        const signer = spendingCondition.signer as string;
        const hashMode = spendingCondition.hashMode as number | undefined;
        // Use testnet version by default since we can't reliably determine network
        const version = hashMode === 0 ? AddressVersion.TestnetSingleSig : AddressVersion.TestnetMultiSig;
        sender = Address.stringify({ hash160: signer, version });
      }

      // Get fee and nonce
      const fee = spendingCondition?.fee ? String(spendingCondition.fee) : "0";
      const nonce = Number(spendingCondition?.nonce || 0);

      // Extract payload details based on type
      let payloadDetails: Record<string, unknown> = {};

      if (txType === "token_transfer" && payload?.recipient && payload?.amount) {
        payloadDetails = {
          recipient: payload.recipient,
          amount: String(payload.amount),
          memo: payload.memo,
        };
      } else if (txType === "contract_call" && payload?.contractAddress) {
        payloadDetails = {
          contractAddress: payload.contractAddress,
          contractName: payload.contractName,
          functionName: payload.functionName,
          functionArgsCount: Array.isArray(payload.functionArgs) ? payload.functionArgs.length : 0,
        };
      } else if (txType === "smart_contract" || txType === "versioned_smart_contract") {
        payloadDetails = {
          contractName: payload?.contractName,
          codeBodyLength: typeof payload?.codeBody === "string" ? payload.codeBody.length : 0,
        };
      }

      // Post conditions info
      const postConditions = txAny.postConditions as Record<string, unknown> | undefined;
      const postConditionCount = Array.isArray(postConditions)
        ? postConditions.length
        : (postConditions as { values?: unknown[] })?.values?.length || 0;

      return c.json({
        ok: true,
        txType,
        sender,
        nonce,
        fee,
        anchorMode: txAny.anchorMode,
        postConditionMode: txAny.postConditionMode,
        payload: payloadDetails,
        postConditionCount,
        tokenType,
      });
    } catch (error) {
      c.var.logger.warn("Failed to decode transaction", {
        error: String(error),
      });
      return this.errorResponse(c, `Failed to decode: ${error instanceof Error ? error.message : String(error)}`, 400);
    }
  }
}
