/**
 * Queue Status Endpoint
 */
import { StorageReadEndpoint } from "../../base";
import { tokenTypeParam, response402 } from "../../schema";
import type { AppContext } from "../../../types";

export class QueueStatus extends StorageReadEndpoint {
  schema = {
    tags: ["Storage - Queue"],
    summary: "(paid, storage_read) Get queue status",
    parameters: [
      { name: "name", in: "query" as const, required: true, schema: { type: "string" as const } },
      tokenTypeParam,
    ],
    responses: {
      "200": { description: "Queue status" },
      "402": response402,
    },
  };

  async handle(c: AppContext) {
    const tokenType = this.getTokenType(c);
    const name = c.req.query("name");

    if (!name) return this.errorResponse(c, "name is required", 400);

    const storageDO = this.requireStorageDO(c);
    if (storageDO instanceof Response) return storageDO;

    const result = await storageDO.queueStatus(name);
    return c.json({ ok: true, name, ...result, tokenType });
  }
}
