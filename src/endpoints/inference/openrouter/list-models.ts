/**
 * OpenRouter List Models Endpoint
 *
 * Free endpoint that lists available models from OpenRouter.
 */

import { FreeEndpoint } from "../../base";
import { OpenRouterClient, OpenRouterError } from "../../../services/openrouter";
import type { AppContext } from "../../../types";

export class OpenRouterListModels extends FreeEndpoint {
  schema = {
    tags: ["Inference"],
    summary: "(free) List available OpenRouter models",
    description: "Returns a list of all available models from OpenRouter with their pricing and capabilities.",
    responses: {
      "200": {
        description: "List of available models",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                ok: { type: "boolean" as const },
                models: {
                  type: "array" as const,
                  items: {
                    type: "object" as const,
                    properties: {
                      id: { type: "string" as const },
                      name: { type: "string" as const },
                      contextLength: { type: "integer" as const },
                      pricing: {
                        type: "object" as const,
                        properties: {
                          prompt: { type: "string" as const },
                          completion: { type: "string" as const },
                        },
                      },
                    },
                  },
                },
                count: { type: "integer" as const },
              },
            },
          },
        },
      },
      "500": {
        description: "Server error",
      },
    },
  };

  async handle(c: AppContext) {
    const log = c.var.logger;

    if (!c.env.OPENROUTER_API_KEY) {
      return this.errorResponse(c, "OpenRouter API key not configured", 500);
    }

    const client = new OpenRouterClient(c.env.OPENROUTER_API_KEY, log);

    try {
      const response = await client.getModels();

      // Belt-and-suspenders guard: Phase 1 validator ensures .data is an array,
      // but guard defensively in case the validator contract ever changes.
      if (!Array.isArray(response.data)) {
        log.warn("OpenRouter models response missing .data array");
        return c.json({ ok: true, models: [], count: 0 });
      }

      const models = response.data
        .map((model) => {
          // Guard model.pricing before accessing .prompt/.completion.
          // Skip models with missing or invalid pricing rather than crashing.
          if (
            typeof model.pricing !== "object" ||
            model.pricing === null ||
            typeof model.pricing.prompt !== "string" ||
            typeof model.pricing.completion !== "string"
          ) {
            log.debug("Skipping model with invalid pricing", { modelId: model.id });
            return null;
          }

          return {
            id: model.id,
            name: model.name,
            description: model.description,
            contextLength: model.context_length,
            pricing: {
              prompt: model.pricing.prompt,
              completion: model.pricing.completion,
            },
          };
        })
        .filter((m): m is NonNullable<typeof m> => m !== null);

      return c.json({
        ok: true,
        models,
        count: models.length,
      });
    } catch (error) {
      if (error instanceof OpenRouterError) {
        log.error("OpenRouter error listing models", {
          status: error.status,
          message: error.message,
        });
        return this.errorResponse(c, error.message, error.status >= 500 ? 502 : 500);
      }

      log.error("Unexpected error listing models", {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.errorResponse(c, "Failed to list models", 500);
    }
  }
}
