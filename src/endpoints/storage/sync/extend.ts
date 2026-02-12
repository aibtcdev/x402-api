/**
 * Sync Extend Endpoint
 */
import { StorageWriteEndpoint } from "../../base";
import { tokenTypeParam, response402 } from "../../schema";
import type { AppContext } from "../../../types";

export class SyncExtend extends StorageWriteEndpoint {
  schema = {
    tags: ["Storage - Sync"],
    summary: "(paid, storage_write) Extend a lock's TTL",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["name", "token"],
            properties: {
              name: { type: "string" as const },
              token: { type: "string" as const },
              ttl: { type: "integer" as const, description: "New TTL in seconds" },
            },
          },
        },
      },
    },
    parameters: [tokenTypeParam],
    responses: {
      "200": { description: "Extend result" },
      "402": response402,
    },
  };

  async handle(c: AppContext) {
    const tokenType = this.getTokenType(c);
    const body = await this.parseBody<{ name?: string; token?: string; ttl?: number }>(c);
    if (body instanceof Response) return body;

    const { name, token, ttl } = body;
    if (!name || !token) return this.errorResponse(c, "name and token are required", 400);

    const storageDO = this.getStorageDO(c);
    if (!storageDO) return this.errorResponse(c, "Storage not available", 500);

    const result = await storageDO.syncExtend(name, token, { ttl });
    return c.json({ ok: true, ...result, tokenType });
  }
}
