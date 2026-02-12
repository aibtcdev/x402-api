/**
 * Sync Lock Endpoint
 */
import { StorageWriteEndpoint } from "../../base";
import { tokenTypeParam, response402 } from "../../schema";
import type { AppContext } from "../../../types";

export class SyncLock extends StorageWriteEndpoint {
  schema = {
    tags: ["Storage - Sync"],
    summary: "(paid, storage_write) Acquire a distributed lock",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["name"],
            properties: {
              name: { type: "string" as const, description: "Lock name" },
              ttl: { type: "integer" as const, description: "TTL in seconds (10-300, default 60)" },
            },
          },
        },
      },
    },
    parameters: [tokenTypeParam],
    responses: {
      "200": { description: "Lock result with token if acquired" },
      "402": response402,
    },
  };

  async handle(c: AppContext) {
    const tokenType = this.getTokenType(c);
    const body = await this.parseBody<{ name?: string; ttl?: number }>(c);
    if (body instanceof Response) return body;

    const { name, ttl } = body;
    if (!name) return this.errorResponse(c, "name is required", 400);

    const storageDO = this.requireStorageDO(c);
    if (storageDO instanceof Response) return storageDO;

    const result = await storageDO.syncLock(name, { ttl });
    return c.json({ ok: true, ...result, tokenType });
  }
}
