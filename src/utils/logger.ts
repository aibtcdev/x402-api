/**
 * Centralized Logger for x402 API Host
 *
 * Sends logs to worker-logs service via RPC binding.
 * Uses CF-Ray ID for request correlation.
 *
 * Based on stx402 logger implementation.
 */

import type { Context, ExecutionContext } from "hono";
import type { Env, Logger, LogsRPC, AppVariables } from "../types";

const APP_ID = "x402-api-host";

// =============================================================================
// Console Fallback (for local dev without LOGS binding)
// =============================================================================

function createConsoleLogger(baseContext?: Record<string, unknown>): Logger {
  const formatMessage = (
    level: string,
    message: string,
    data?: Record<string, unknown>
  ) => {
    const timestamp = new Date().toISOString();
    const ctx = { ...baseContext, ...data };
    const ctxStr = Object.keys(ctx).length > 0 ? ` ${JSON.stringify(ctx)}` : "";
    return `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${message}${ctxStr}`;
  };

  return {
    debug: (msg, data) => console.debug(formatMessage("debug", msg, data)),
    info: (msg, data) => console.info(formatMessage("info", msg, data)),
    warn: (msg, data) => console.warn(formatMessage("warn", msg, data)),
    error: (msg, data) => console.error(formatMessage("error", msg, data)),
    child: (additionalContext) =>
      createConsoleLogger({ ...baseContext, ...additionalContext }),
  };
}

// =============================================================================
// RPC Logger (production)
// =============================================================================

/**
 * Create a logger that sends to worker-logs via RPC
 */
export function createLogger(
  logs: LogsRPC,
  ctx: ExecutionContext,
  baseContext?: Record<string, unknown>
): Logger {
  const send = (
    rpcCall: Promise<unknown>,
    level: string,
    message: string,
    context: Record<string, unknown>
  ) => {
    ctx.waitUntil(
      rpcCall.catch((err) => {
        console.error(`[logger] Failed to send ${level} log: ${err}`);
        console.error(`[logger] Original message: ${message}`, context);
      })
    );
  };

  return {
    debug: (msg, data) => {
      const context = { ...baseContext, ...data };
      send(logs.debug(APP_ID, msg, context), "debug", msg, context);
    },
    info: (msg, data) => {
      const context = { ...baseContext, ...data };
      send(logs.info(APP_ID, msg, context), "info", msg, context);
    },
    warn: (msg, data) => {
      const context = { ...baseContext, ...data };
      send(logs.warn(APP_ID, msg, context), "warn", msg, context);
    },
    error: (msg, data) => {
      const context = { ...baseContext, ...data };
      send(logs.error(APP_ID, msg, context), "error", msg, context);
    },
    child: (additionalContext) =>
      createLogger(logs, ctx, { ...baseContext, ...additionalContext }),
  };
}

// =============================================================================
// Hono Middleware
// =============================================================================

/**
 * Hono middleware that creates a logger and stores it in context
 */
export function loggerMiddleware(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  next: () => Promise<void>
) {
  const rayId = c.req.header("cf-ray") || crypto.randomUUID();
  const path = c.req.path;
  const baseContext = { rayId, path };

  // Use RPC logger if LOGS binding available, otherwise console
  const logger = c.env.LOGS
    ? createLogger(c.env.LOGS as unknown as LogsRPC, c.executionCtx, baseContext)
    : createConsoleLogger(baseContext);

  c.set("requestId", rayId);
  c.set("logger", logger);

  return next();
}

/**
 * Get logger from Hono context
 */
export function getLogger(c: Context<{ Bindings: Env; Variables: AppVariables }>): Logger {
  const logger = c.get("logger");
  if (!logger) {
    console.warn("[logger] No logger in context, using console fallback");
    return createConsoleLogger({ path: c.req.path });
  }
  return logger;
}

/**
 * Create a standalone logger for use outside of request handlers
 */
export function createStandaloneLogger(
  env: Env,
  ctx: ExecutionContext,
  baseContext?: Record<string, unknown>
): Logger {
  if (env.LOGS) {
    return createLogger(env.LOGS as unknown as LogsRPC, ctx, baseContext);
  }
  return createConsoleLogger(baseContext);
}
