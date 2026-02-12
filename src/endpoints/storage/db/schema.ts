/**
 * DB Schema Endpoint
 */
import { StorageReadEndpoint } from "../../base";
import { tokenTypeParam, response402 } from "../../schema";
import type { AppContext } from "../../../types";

export class DbSchema extends StorageReadEndpoint {
  schema = {
    tags: ["Storage - DB"],
    summary: "(paid, storage_read) Get database schema",
    parameters: [tokenTypeParam],
    responses: {
      "200": { description: "Database schema" },
      "402": response402,
    },
  };

  async handle(c: AppContext) {
    const tokenType = this.getTokenType(c);
    const storageDO = this.getStorageDO(c);
    if (!storageDO) return this.errorResponse(c, "Storage not available", 500);

    const result = await storageDO.sqlSchema();
    return c.json({ ok: true, ...result, tokenType });
  }
}
