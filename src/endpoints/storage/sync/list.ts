/**
 * Sync List Endpoint
 */
import { StorageReadEndpoint } from "../../base";
import { tokenTypeParam, response402 } from "../../schema";
import type { AppContext } from "../../../types";

export class SyncList extends StorageReadEndpoint {
  schema = {
    tags: ["Storage - Sync"],
    summary: "(paid, storage_read) List active locks",
    parameters: [tokenTypeParam],
    responses: {
      "200": { description: "List of locks" },
      "402": response402,
    },
  };

  async handle(c: AppContext) {
    const tokenType = this.getTokenType(c);
    const storageDO = this.requireStorageDO(c);
    if (storageDO instanceof Response) return storageDO;

    const locks = await storageDO.syncList();
    return c.json({ ok: true, locks, count: locks.length, tokenType });
  }
}
