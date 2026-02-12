/**
 * KV Set Endpoint
 */

import { StorageWriteEndpoint } from "../../base";
import { tokenTypeParam, response400, response402, stringProp, boolProp, objectProp, intProp, okProp, tokenTypeProp } from "../../schema";
import type { AppContext } from "../../../types";

export class KvSet extends StorageWriteEndpoint {
  schema = {
    tags: ["Storage - KV"],
    summary: "(paid, storage_write) Set value in KV store",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["key", "value"],
            properties: {
              key: { ...stringProp, description: "Key to set" },
              value: { ...stringProp, description: "Value to store" },
              metadata: { ...objectProp, description: "Optional metadata" },
              ttl: { ...intProp, description: "TTL in seconds (optional)" },
            },
          },
        },
      },
    },
    parameters: [tokenTypeParam],
    responses: {
      "200": {
        description: "Value set",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: { ok: okProp, key: stringProp, created: boolProp, tokenType: tokenTypeProp },
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

    const body = await this.parseBody<{ key?: string; value?: string; metadata?: Record<string, unknown>; ttl?: number }>(c);
    if (body instanceof Response) return body;

    const { key, value, metadata, ttl } = body;

    if (!key || typeof key !== "string") {
      return this.errorResponse(c, "key is required", 400);
    }
    if (!value || typeof value !== "string") {
      return this.errorResponse(c, "value is required", 400);
    }

    const storageDO = this.requireStorageDO(c);
    if (storageDO instanceof Response) return storageDO;

    const result = await storageDO.kvSet(key, value, { metadata, ttl });

    return c.json({
      ok: true,
      key: result.key,
      created: result.created,
      tokenType,
    });
  }
}
