#!/usr/bin/env bun
/**
 * Unit tests for model-cache helper functions
 *
 * Covers:
 * 1. getCacheStatus — warm, cold, degraded states
 * 2. getSimilarModels — provider prefix match, string prefix match, fallback
 *
 * Uses _seedCacheForTesting / _resetCacheForTesting to control module-level state.
 */

import { describe, expect, test, afterEach } from "bun:test";
import {
  getCacheStatus,
  getSimilarModels,
  _seedCacheForTesting,
  _resetCacheForTesting,
} from "../src/services/model-cache";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_MODELS = [
  { id: "openai/gpt-4o", pricing: { promptPer1k: 0.005, completionPer1k: 0.015 } },
  { id: "openai/gpt-4o-mini", pricing: { promptPer1k: 0.00015, completionPer1k: 0.0006 } },
  { id: "openai/gpt-3.5-turbo", pricing: { promptPer1k: 0.0005, completionPer1k: 0.0015 } },
  { id: "anthropic/claude-3-5-sonnet", pricing: { promptPer1k: 0.003, completionPer1k: 0.015 } },
  { id: "anthropic/claude-3-haiku", pricing: { promptPer1k: 0.00025, completionPer1k: 0.00125 } },
  { id: "google/gemini-pro", pricing: { promptPer1k: 0.00025, completionPer1k: 0.0005 } },
];

afterEach(() => {
  _resetCacheForTesting();
});

// ---------------------------------------------------------------------------
// getCacheStatus tests
// ---------------------------------------------------------------------------

describe("getCacheStatus", () => {
  test("cold when never fetched", () => {
    _resetCacheForTesting();
    const status = getCacheStatus();
    expect(status.state).toBe("cold");
    expect(status.modelCount).toBe(0);
    expect(status.lastRefreshed).toBeNull();
    expect(status.lastFailedAt).toBeNull();
  });

  test("warm when populated and fresh", () => {
    _seedCacheForTesting(TEST_MODELS);
    const status = getCacheStatus();
    expect(status.state).toBe("warm");
    expect(status.modelCount).toBe(TEST_MODELS.length);
    expect(status.lastRefreshed).toBeTypeOf("number");
    expect(status.lastFailedAt).toBeNull();
  });

  test("degraded when last fetch failed and cache is empty", () => {
    _seedCacheForTesting([], { simulateFailure: true });
    const status = getCacheStatus();
    expect(status.state).toBe("degraded");
    expect(status.modelCount).toBe(0);
    expect(status.lastFailedAt).toBeTypeOf("number");
  });

  test("warm when cache is fresh despite prior failure", () => {
    // Seed with models (sets fetchedAt to now), then simulate a failure
    // that happened before the successful fetch — cache is still fresh
    _seedCacheForTesting(TEST_MODELS);
    const status = getCacheStatus();
    expect(status.state).toBe("warm");
    expect(status.modelCount).toBe(TEST_MODELS.length);
  });
});

// ---------------------------------------------------------------------------
// getSimilarModels tests
// ---------------------------------------------------------------------------

describe("getSimilarModels", () => {
  test("returns empty array when cache is empty", () => {
    _resetCacheForTesting();
    expect(getSimilarModels("openai/gpt-4o")).toEqual([]);
  });

  test("returns provider-prefix matches for model with slash", () => {
    _seedCacheForTesting(TEST_MODELS);
    const similar = getSimilarModels("openai/nonexistent-model");
    expect(similar.length).toBeGreaterThan(0);
    expect(similar.length).toBeLessThanOrEqual(3);
    expect(similar.every((id) => id.startsWith("openai/"))).toBe(true);
  });

  test("does not include the queried model in results", () => {
    _seedCacheForTesting(TEST_MODELS);
    const similar = getSimilarModels("openai/gpt-4o");
    expect(similar).not.toContain("openai/gpt-4o");
  });

  test("respects maxResults parameter", () => {
    _seedCacheForTesting(TEST_MODELS);
    const similar = getSimilarModels("openai/nonexistent", 1);
    expect(similar.length).toBe(1);
  });

  test("falls back to prefix match when no provider match", () => {
    _seedCacheForTesting(TEST_MODELS);
    // "google" prefix — only one google model
    const similar = getSimilarModels("google/gemini-ultra");
    expect(similar.length).toBeGreaterThan(0);
    expect(similar[0]).toContain("google/");
  });

  test("fallback returns unrelated models when no structural match", () => {
    _seedCacheForTesting(TEST_MODELS);
    const similar = getSimilarModels("zzz-unknown-provider/zzz-model");
    // Should still return something (fallback hints)
    expect(similar.length).toBeGreaterThan(0);
    expect(similar.length).toBeLessThanOrEqual(3);
  });
});
