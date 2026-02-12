/**
 * Paste Get Endpoint
 */

import { StorageReadEndpoint } from "../../base";
import { tokenTypeParam, pathParam, response402, stringProp, okProp, tokenTypeProp } from "../../schema";
import type { AppContext } from "../../../types";

export class PasteGet extends StorageReadEndpoint {
  schema = {
    tags: ["Storage - Paste"],
    summary: "(paid, storage_read) Get a paste by ID",
    parameters: [pathParam("id", "Paste ID"), tokenTypeParam],
    responses: {
      "200": {
        description: "Paste retrieved",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: { ok: okProp, id: stringProp, content: stringProp, title: stringProp, language: stringProp, createdAt: stringProp, expiresAt: stringProp, tokenType: tokenTypeProp },
            },
          },
        },
      },
      "402": response402,
      "404": { description: "Paste not found" },
    },
  };

  async handle(c: AppContext) {
    const tokenType = this.getTokenType(c);
    const id = c.req.param("id");

    if (!id) {
      return this.errorResponse(c, "id parameter is required", 400);
    }

    const storageDO = this.requireStorageDO(c);
    if (storageDO instanceof Response) return storageDO;

    const result = await storageDO.pasteGet(id);

    if (!result) {
      return this.errorResponse(c, `Paste '${id}' not found`, 404);
    }

    return c.json({
      ok: true,
      ...result,
      tokenType,
    });
  }
}
