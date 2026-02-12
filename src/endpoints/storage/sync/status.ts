/**
 * Sync Status Endpoint
 */
import { StorageReadEndpoint } from "../../base";
import { tokenTypeParam, response402 } from "../../schema";
import type { AppContext } from "../../../types";

export class SyncStatus extends StorageReadEndpoint {
  schema = {
    tags: ["Storage - Sync"],
    summary: "(paid, storage_read) Check lock status",
    parameters: [
      { name: "name", in: "path" as const, required: true, schema: { type: "string" as const } },
      tokenTypeParam,
    ],
    responses: {
      "200": { description: "Lock status" },
      "402": response402,
    },
  };

  async handle(c: AppContext) {
    const tokenType = this.getTokenType(c);
    const name = c.req.param("name");
    if (!name) return this.errorResponse(c, "name is required", 400);

    const storageDO = this.requireStorageDO(c);
    if (storageDO instanceof Response) return storageDO;

    const result = await storageDO.syncStatus(name);
    return c.json({ ok: true, name, ...result, tokenType });
  }
}
