/**
 * Paste Create Endpoint
 */

import { StorageWriteLargeEndpoint } from "../../base";
import { tokenTypeParam, response400, response402, stringProp, intProp, okProp, tokenTypeProp } from "../../schema";
import type { AppContext } from "../../../types";

export class PasteCreate extends StorageWriteLargeEndpoint {
  schema = {
    tags: ["Storage - Paste"],
    summary: "(paid, storage_write_large) Create a new paste",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["content"],
            properties: {
              content: { ...stringProp, description: "Paste content" },
              title: { ...stringProp, description: "Optional title" },
              language: { ...stringProp, description: "Programming language for syntax highlighting" },
              ttl: { ...intProp, description: "TTL in seconds (optional)" },
            },
          },
        },
      },
    },
    parameters: [tokenTypeParam],
    responses: {
      "200": {
        description: "Paste created",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: { ok: okProp, id: stringProp, createdAt: stringProp, expiresAt: stringProp, tokenType: tokenTypeProp },
            },
          },
        },
      },
      "400": response400,
      "402": response402,
    },
  };

  async handle(c: AppContext) {
    const tokenType = this.getTokenType(c);

    const body = await this.parseBody<{ content?: string; title?: string; language?: string; ttl?: number }>(c);
    if (body instanceof Response) return body;

    const { content, title, language, ttl } = body;

    if (!content || typeof content !== "string") {
      return this.errorResponse(c, "content is required", 400);
    }

    const storageDO = this.requireStorageDO(c);
    if (storageDO instanceof Response) return storageDO;

    const result = await storageDO.pasteCreate(content, { title, language, ttl });

    return c.json({
      ok: true,
      id: result.id,
      createdAt: result.createdAt,
      expiresAt: result.expiresAt,
      tokenType,
    });
  }
}
