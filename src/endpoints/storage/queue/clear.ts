/**
 * Queue Clear Endpoint
 */
import { StorageWriteEndpoint } from "../../base";
import { tokenTypeParam, response402 } from "../../schema";
import type { AppContext } from "../../../types";

export class QueueClear extends StorageWriteEndpoint {
  schema = {
    tags: ["Storage - Queue"],
    summary: "(paid, storage_write) Clear all items from a queue",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["name"],
            properties: {
              name: { type: "string" as const, description: "Queue name" },
            },
          },
        },
      },
    },
    parameters: [tokenTypeParam],
    responses: {
      "200": { description: "Clear result" },
      "402": response402,
    },
  };

  async handle(c: AppContext) {
    const tokenType = this.getTokenType(c);
    let body: { name?: string };
    try { body = await c.req.json(); } catch { return this.errorResponse(c, "Invalid JSON body", 400); }

    const { name } = body;
    if (!name) return this.errorResponse(c, "name is required", 400);

    const storageDO = this.getStorageDO(c);
    if (!storageDO) return this.errorResponse(c, "Storage not available", 500);

    const result = await storageDO.queueClear(name);
    return c.json({ ok: true, ...result, tokenType });
  }
}
