/**
 * Paste Delete Endpoint
 */

import { StorageWriteEndpoint } from "../../base";
import { tokenTypeParam, pathParam, response402, stringProp, boolProp, okProp, tokenTypeProp } from "../../schema";
import type { AppContext } from "../../../types";

export class PasteDelete extends StorageWriteEndpoint {
  schema = {
    tags: ["Storage - Paste"],
    summary: "(paid, storage_write) Delete a paste",
    parameters: [pathParam("id", "Paste ID to delete"), tokenTypeParam],
    responses: {
      "200": {
        description: "Delete result",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: { ok: okProp, deleted: boolProp, id: stringProp, tokenType: tokenTypeProp },
            },
          },
        },
      },
      "402": response402,
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

    const result = await storageDO.pasteDelete(id);

    return c.json({
      ok: true,
      deleted: result.deleted,
      id,
      tokenType,
    });
  }
}
