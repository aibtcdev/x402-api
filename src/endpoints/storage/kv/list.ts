/**
 * KV List Endpoint
 */

import { StorageReadEndpoint } from "../../base";
import { tokenTypeParam, queryParamString, queryParamInt, response402, stringProp, objectProp, intProp, okProp, tokenTypeProp } from "../../schema";
import type { AppContext } from "../../../types";

export class KvList extends StorageReadEndpoint {
  schema = {
    tags: ["Storage - KV"],
    summary: "(paid, storage_read) List keys in KV store",
    parameters: [
      queryParamString("prefix", "Filter by key prefix"),
      queryParamInt("limit", "Max results to return", 100),
      tokenTypeParam,
    ],
    responses: {
      "200": {
        description: "List of keys",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                ok: okProp,
                keys: {
                  type: "array" as const,
                  items: {
                    type: "object" as const,
                    properties: { key: stringProp, metadata: objectProp, updatedAt: stringProp },
                  },
                },
                count: intProp,
                tokenType: tokenTypeProp,
              },
            },
          },
        },
      },
      "402": response402,
    },
  };

  async handle(c: AppContext) {
    const tokenType = this.getTokenType(c);
    const prefix = c.req.query("prefix");
    const limit = parseInt(c.req.query("limit") || "100", 10);

    const storageDO = this.requireStorageDO(c);
    if (storageDO instanceof Response) return storageDO;

    const keys = await storageDO.kvList({ prefix, limit }) as Array<{
      key: string;
      metadata: Record<string, unknown> | null;
      updatedAt: string;
    }>;

    return c.json({
      ok: true,
      keys,
      count: keys.length,
      tokenType,
    });
  }
}
