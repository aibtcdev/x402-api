/**
 * DB Query Endpoint
 */
import { StorageReadEndpoint } from "../../base";
import { tokenTypeParam, response400, response402 } from "../../schema";
import type { AppContext } from "../../../types";

export class DbQuery extends StorageReadEndpoint {
  schema = {
    tags: ["Storage - DB"],
    summary: "(paid, storage_read) Execute a read-only SQL query",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["query"],
            properties: {
              query: { type: "string" as const, description: "SQL SELECT query" },
              params: { type: "array" as const, description: "Query parameters" },
            },
          },
        },
      },
    },
    parameters: [tokenTypeParam],
    responses: {
      "200": { description: "Query results" },
      "400": response400,
      "402": response402,
    },
  };

  async handle(c: AppContext) {
    const tokenType = this.getTokenType(c);
    let body: { query?: string; params?: unknown[] };
    try { body = await c.req.json(); } catch { return this.errorResponse(c, "Invalid JSON body", 400); }

    const { query, params = [] } = body;
    if (!query) return this.errorResponse(c, "query is required", 400);

    const storageDO = this.getStorageDO(c);
    if (!storageDO) return this.errorResponse(c, "Storage not available", 500);

    try {
      const result = await storageDO.sqlQuery(query, params) as { rows: unknown[]; rowCount: number; columns: string[] };
      return c.json({ ok: true, rows: result.rows, rowCount: result.rowCount, columns: result.columns, tokenType });
    } catch (e) {
      return this.errorResponse(c, String(e), 400);
    }
  }
}
