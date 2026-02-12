/**
 * Queue Push Endpoint
 */
import { StorageWriteEndpoint } from "../../base";
import { tokenTypeParam, response402 } from "../../schema";
import type { AppContext } from "../../../types";

export class QueuePush extends StorageWriteEndpoint {
  schema = {
    tags: ["Storage - Queue"],
    summary: "(paid, storage_write) Push items to a queue",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["name", "items"],
            properties: {
              name: { type: "string" as const, description: "Queue name" },
              items: {
                type: "array" as const,
                items: {},
                description: "Items to push (any JSON values)",
              },
              priority: {
                type: "integer" as const,
                description: "Priority level (higher = processed first)",
                default: 0,
              },
            },
          },
        },
      },
    },
    parameters: [tokenTypeParam],
    responses: {
      "200": { description: "Push result" },
      "402": response402,
    },
  };

  async handle(c: AppContext) {
    const tokenType = this.getTokenType(c);
    const body = await this.parseBody<{ name?: string; items?: unknown[]; priority?: number }>(c);
    if (body instanceof Response) return body;

    const { name, items, priority } = body;
    if (!name || !items || !Array.isArray(items)) {
      return this.errorResponse(c, "name and items array are required", 400);
    }

    const storageDO = this.getStorageDO(c);
    if (!storageDO) return this.errorResponse(c, "Storage not available", 500);

    const result = await storageDO.queuePush(name, items, { priority });
    return c.json({ ok: true, ...result, tokenType });
  }
}
