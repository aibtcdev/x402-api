/**
 * Memory Search Endpoint
 * Semantic search using vector embeddings
 */
import { StorageReadEndpoint } from "../../base";
import { tokenTypeParam, response402 } from "../../schema";
import type { AppContext } from "../../../types";

export class MemorySearch extends StorageReadEndpoint {
  schema = {
    tags: ["Storage - Memory"],
    summary: "(paid, storage_read) Search memory by semantic similarity",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["query"],
            properties: {
              query: { type: "string" as const, description: "Search query" },
              limit: { type: "integer" as const, description: "Max results", default: 10 },
              threshold: { type: "number" as const, description: "Minimum similarity (0-1)", default: 0.5 },
            },
          },
        },
      },
    },
    parameters: [tokenTypeParam],
    responses: {
      "200": { description: "Search results" },
      "402": response402,
    },
  };

  async handle(c: AppContext) {
    const tokenType = this.getTokenType(c);
    const body = await this.parseBody<{ query?: string; limit?: number; threshold?: number }>(c);
    if (body instanceof Response) return body;

    const { query, limit = 10, threshold = 0.5 } = body;
    if (!query) return this.errorResponse(c, "query is required", 400);

    const storageDO = this.getStorageDO(c);
    if (!storageDO) return this.errorResponse(c, "Storage not available", 500);

    // Generate embedding for query
    const env = c.env;
    let queryEmbedding: number[];
    try {
      const result = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: [query] }) as { data: number[][] };
      queryEmbedding = result.data[0];
    } catch (err) {
      return this.errorResponse(c, `Embedding generation failed: ${err}`, 500);
    }

    const result = await storageDO.memorySearch(queryEmbedding, { limit, threshold }) as {
      results: Array<{ id: string; text: string; metadata: Record<string, unknown> | null; similarity: number }>;
    };
    return c.json({ ok: true, query, results: result.results, tokenType });
  }
}
