/**
 * Memory Store Endpoint
 * Store text with vector embeddings for semantic search
 */
import { StorageWriteLargeEndpoint } from "../../base";
import { tokenTypeParam, response402 } from "../../schema";
import type { AppContext } from "../../../types";
import { scanContent } from "../../../services/safety-scan";

export class MemoryStore extends StorageWriteLargeEndpoint {
  schema = {
    tags: ["Storage - Memory"],
    summary: "(paid, standard) Store text with embeddings",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["items"],
            properties: {
              items: {
                type: "array" as const,
                items: {
                  type: "object" as const,
                  required: ["id", "text"],
                  properties: {
                    id: { type: "string" as const, description: "Unique identifier" },
                    text: { type: "string" as const, description: "Text to embed and store" },
                    metadata: { type: "object" as const, description: "Optional metadata" },
                  },
                },
                description: "Items to store",
              },
            },
          },
        },
      },
    },
    parameters: [tokenTypeParam],
    responses: {
      "200": { description: "Store result" },
      "402": response402,
    },
  };

  async handle(c: AppContext) {
    const tokenType = this.getTokenType(c);
    const body = await this.parseBody<{ items?: Array<{ id: string; text: string; metadata?: Record<string, unknown> }> }>(c);
    if (body instanceof Response) return body;

    const { items } = body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return this.errorResponse(c, "items array is required", 400);
    }

    // Validate items
    for (const item of items) {
      if (!item.id || !item.text) {
        return this.errorResponse(c, "Each item must have id and text", 400);
      }
    }

    const storageDO = this.requireStorageDO(c);
    if (storageDO instanceof Response) return storageDO;

    // Generate embeddings using Cloudflare AI
    const env = c.env;
    const texts = items.map(i => i.text);

    let embeddings: number[][];
    try {
      const result = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: texts }) as { data: number[][] };
      embeddings = result.data;
    } catch (err) {
      return this.errorResponse(c, `Embedding generation failed: ${String(err)}`, 500);
    }

    // Store items with embeddings
    const itemsWithEmbeddings = items.map((item, i) => ({
      ...item,
      embedding: embeddings[i],
    }));

    const result = await storageDO.memoryStore(itemsWithEmbeddings);

    // Fire-and-forget safety scan for each item — never blocks response
    const log = c.var.logger;
    c.executionCtx.waitUntil(
      (async () => {
        for (const item of items) {
          try {
            const verdict = await scanContent(c.env.AI, item.text);
            await storageDO.scanStore(item.id, "memory", verdict);
          } catch (err) {
            log.error("Safety scan failed for memory item", { id: item.id, error: String(err) });
          }
        }
      })()
    );

    return c.json({ ok: true, ...result, tokenType });
  }
}
