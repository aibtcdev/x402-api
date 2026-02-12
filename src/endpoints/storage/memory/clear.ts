/**
 * Memory Clear Endpoint
 */
import { StorageWriteEndpoint } from "../../base";
import { tokenTypeParam, response402 } from "../../schema";
import type { AppContext } from "../../../types";

export class MemoryClear extends StorageWriteEndpoint {
  schema = {
    tags: ["Storage - Memory"],
    summary: "(paid, storage_write) Clear all memory items",
    parameters: [tokenTypeParam],
    responses: {
      "200": { description: "Clear result" },
      "402": response402,
    },
  };

  async handle(c: AppContext) {
    const tokenType = this.getTokenType(c);

    const storageDO = this.getStorageDO(c);
    if (!storageDO) return this.errorResponse(c, "Storage not available", 500);

    const result = await storageDO.memoryClear();
    return c.json({ ok: true, ...result, tokenType });
  }
}
