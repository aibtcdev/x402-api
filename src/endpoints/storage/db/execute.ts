/**
 * DB Execute Endpoint
 */
import { StorageWriteEndpoint } from "../../base";
import { tokenTypeParam, response400, response402 } from "../../schema";
import type { AppContext } from "../../../types";

export class DbExecute extends StorageWriteEndpoint {
  schema = {
    tags: ["Storage - DB"],
    summary: "(paid, storage_write) Execute a write SQL statement",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["query"],
            properties: {
              query: { type: "string" as const, description: "SQL statement (CREATE, INSERT, UPDATE, DELETE)" },
              params: { type: "array" as const, description: "Query parameters" },
            },
          },
        },
      },
    },
    parameters: [tokenTypeParam],
    responses: {
      "200": { description: "Execution result" },
      "400": response400,
      "402": response402,
    },
  };

  async handle(c: AppContext) {
    const tokenType = this.getTokenType(c);
    const body = await this.parseBody<{ query?: string; params?: unknown[] }>(c);
    if (body instanceof Response) return body;

    const { query, params = [] } = body;
    if (!query) return this.errorResponse(c, "query is required", 400);

    const storageDO = this.requireStorageDO(c);
    if (storageDO instanceof Response) return storageDO;

    try {
      const result = await storageDO.sqlExecute(query, params);
      return c.json({ ok: true, ...result, tokenType });
    } catch (e) {
      return this.errorResponse(c, String(e), 400);
    }
  }
}
