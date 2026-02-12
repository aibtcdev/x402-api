/**
 * Queue Pop Endpoint
 */
import { StorageWriteEndpoint } from "../../base";
import { tokenTypeParam, response402 } from "../../schema";
import type { AppContext } from "../../../types";

export class QueuePop extends StorageWriteEndpoint {
  schema = {
    tags: ["Storage - Queue"],
    summary: "(paid, storage_write) Pop items from a queue",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["name"],
            properties: {
              name: { type: "string" as const, description: "Queue name" },
              count: {
                type: "integer" as const,
                description: "Number of items to pop",
                default: 1,
              },
            },
          },
        },
      },
    },
    parameters: [tokenTypeParam],
    responses: {
      "200": { description: "Popped items" },
      "402": response402,
    },
  };

  async handle(c: AppContext) {
    const tokenType = this.getTokenType(c);
    const body = await this.parseBody<{ name?: string; count?: number }>(c);
    if (body instanceof Response) return body;

    const { name, count = 1 } = body;
    if (!name) return this.errorResponse(c, "name is required", 400);

    const storageDO = this.requireStorageDO(c);
    if (storageDO instanceof Response) return storageDO;

    const result = await storageDO.queuePop(name, count) as {
      items: Array<{ id: string; data: unknown }>;
      count: number;
    };
    return c.json({ ok: true, items: result.items, count: result.count, tokenType });
  }
}
