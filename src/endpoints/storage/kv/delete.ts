/**
 * KV Delete Endpoint
 */

import { StorageWriteEndpoint } from "../../base";
import { tokenTypeParam, pathParam, response402, stringProp, boolProp, okProp, tokenTypeProp } from "../../schema";
import type { AppContext } from "../../../types";

export class KvDelete extends StorageWriteEndpoint {
  schema = {
    tags: ["Storage - KV"],
    summary: "(paid, storage_write) Delete key from KV store",
    parameters: [pathParam("key", "Key to delete"), tokenTypeParam],
    responses: {
      "200": {
        description: "Delete result",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: { ok: okProp, deleted: boolProp, key: stringProp, tokenType: tokenTypeProp },
            },
          },
        },
      },
      "402": response402,
    },
  };

  async handle(c: AppContext) {
    const tokenType = this.getTokenType(c);
    const key = c.req.param("key");

    if (!key) {
      return this.errorResponse(c, "key parameter is required", 400);
    }

    const storageDO = this.getStorageDO(c);
    if (!storageDO) {
      return this.errorResponse(c, "Storage not available", 500);
    }

    const result = await storageDO.kvDelete(key);

    return c.json({
      ok: true,
      deleted: result.deleted,
      key,
      tokenType,
    });
  }
}
