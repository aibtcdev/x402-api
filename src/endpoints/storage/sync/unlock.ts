/**
 * Sync Unlock Endpoint
 */
import { StorageWriteEndpoint } from "../../base";
import { tokenTypeParam, response402 } from "../../schema";
import type { AppContext } from "../../../types";

export class SyncUnlock extends StorageWriteEndpoint {
  schema = {
    tags: ["Storage - Sync"],
    summary: "(paid, storage_write) Release a distributed lock",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["name", "token"],
            properties: {
              name: { type: "string" as const, description: "Lock name" },
              token: { type: "string" as const, description: "Lock token from acquire" },
            },
          },
        },
      },
    },
    parameters: [tokenTypeParam],
    responses: {
      "200": { description: "Unlock result" },
      "402": response402,
    },
  };

  async handle(c: AppContext) {
    const tokenType = this.getTokenType(c);
    let body: { name?: string; token?: string };
    try { body = await c.req.json(); } catch { return this.errorResponse(c, "Invalid JSON body", 400); }

    const { name, token } = body;
    if (!name || !token) return this.errorResponse(c, "name and token are required", 400);

    const storageDO = this.getStorageDO(c);
    if (!storageDO) return this.errorResponse(c, "Storage not available", 500);

    const result = await storageDO.syncUnlock(name, token);
    return c.json({ ok: true, ...result, tokenType });
  }
}
