/**
 * KV Get Endpoint
 */

import { StorageReadEndpoint } from "../../base";
import { tokenTypeParam, pathParam, response402, stringProp, objectProp, okProp, tokenTypeProp } from "../../schema";
import type { AppContext } from "../../../types";

export class KvGet extends StorageReadEndpoint {
  schema = {
    tags: ["Storage - KV"],
    summary: "(paid, storage_read) Get value from KV store",
    parameters: [pathParam("key", "Key to retrieve"), tokenTypeParam],
    responses: {
      "200": {
        description: "Value retrieved",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: { ok: okProp, key: stringProp, value: stringProp, metadata: objectProp, createdAt: stringProp, updatedAt: stringProp, tokenType: tokenTypeProp },
            },
          },
        },
      },
      "402": response402,
      "404": { description: "Key not found" },
    },
  };

  async handle(c: AppContext) {
    const tokenType = this.getTokenType(c);
    const key = c.req.param("key");

    if (!key) {
      return this.errorResponse(c, "key parameter is required", 400);
    }

    const storageDO = this.requireStorageDO(c);
    if (storageDO instanceof Response) return storageDO;

    const result = await storageDO.kvGet(key) as {
      key: string;
      value: string;
      metadata: Record<string, unknown> | null;
      createdAt: string;
      updatedAt: string;
    } | null;

    if (!result) {
      return this.errorResponse(c, `Key '${key}' not found`, 404);
    }

    return c.json({
      ok: true,
      key: result.key,
      value: result.value,
      metadata: result.metadata,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
      tokenType,
    });
  }
}
