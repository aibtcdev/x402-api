/**
 * Safety Scan Service
 *
 * Lightweight content classification using Workers AI (Llama 3.1 8B).
 * Classifies user-submitted content and returns a structured verdict.
 *
 * Design: flag-first (never blocks content), fire-and-forget friendly,
 * always returns a verdict even on model/parse failure.
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Structured verdict from the safety scan pipeline.
 * Stored in StorageDO content_scans table for later review.
 */
export interface ScanVerdict {
  /** Whether the content is considered safe */
  safe: boolean;
  /** Category flags triggered (empty if safe) */
  flags: string[];
  /** Model confidence in verdict, 0.0 to 1.0 */
  confidence: number;
  /** Short human-readable reason for the verdict */
  reason: string;
}

// =============================================================================
// Constants
// =============================================================================

/** Maximum characters of content sent to the model for classification */
const MAX_CONTENT_LENGTH = 4000;

/** Model used for classification */
const SCAN_MODEL = "@cf/meta/llama-3.1-8b-instruct";

/** Low temperature for deterministic, structured output */
const SCAN_TEMPERATURE = 0.1;

/** Max output tokens needed for a compact JSON verdict */
const SCAN_MAX_TOKENS = 200;

/**
 * System prompt for the content moderation classifier.
 * Instructs the model to output strict JSON matching ScanVerdict shape.
 */
const SAFETY_SCAN_PROMPT = `You are a content moderation assistant. Your only job is to classify text content as safe or unsafe.

Respond with ONLY a JSON object. No prose, no explanation outside the JSON. The JSON must match this exact shape:
{"safe": boolean, "flags": string[], "confidence": number, "reason": string}

Flag categories (use only these exact strings if applicable):
- "spam" - unsolicited bulk content, repetitive patterns
- "harassment" - targeted threats, insults, or intimidation
- "hate_speech" - content targeting protected characteristics
- "violence" - graphic violence or threats of violence
- "adult_content" - explicit sexual content
- "malware" - code or links that appear malicious
- "pii_exposure" - personal identifying information (SSNs, credit cards, passwords)

Rules:
- "safe" is true when no flags apply
- "flags" is an empty array when safe
- "confidence" is a float from 0.0 to 1.0 (your certainty in this verdict)
- "reason" is one short sentence (under 100 chars)
- When uncertain, default to safe: true with lower confidence
- Respond with ONLY the JSON object, nothing else`;

// =============================================================================
// Service Function
// =============================================================================

/**
 * Default verdict returned on any error (parse failure, model timeout, etc.)
 * Marks as safe with zero confidence so downstream can treat it as unscanned.
 */
const DEFAULT_VERDICT: ScanVerdict = {
  safe: true,
  flags: [],
  confidence: 0,
  reason: "scan_unavailable",
};

/**
 * Parse and validate raw model output into a ScanVerdict.
 * Returns null if the output does not match the expected shape.
 */
function parseVerdict(raw: string): ScanVerdict | null {
  // Extract JSON from response (model may wrap in markdown fences)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;

  // Validate required fields
  if (typeof obj.safe !== "boolean") return null;
  if (!Array.isArray(obj.flags)) return null;
  if (typeof obj.confidence !== "number") return null;
  if (typeof obj.reason !== "string") return null;

  // Validate flags are strings
  if (!obj.flags.every((f: unknown) => typeof f === "string")) return null;

  // Clamp confidence to valid range
  const confidence = Math.max(0, Math.min(1, obj.confidence));

  return {
    safe: obj.safe,
    flags: obj.flags as string[],
    confidence,
    reason: obj.reason.slice(0, 200),
  };
}

/**
 * Scan content using Workers AI classification.
 *
 * - Truncates content to MAX_CONTENT_LENGTH chars
 * - Calls Llama 3.1 8B with a focused system prompt
 * - Parses structured JSON verdict from model output
 * - Returns DEFAULT_VERDICT on any error (never throws)
 *
 * Designed to be called via executionCtx.waitUntil() for fire-and-forget use.
 *
 * @param ai - Workers AI binding from Env
 * @param content - Raw content string to classify
 * @returns Structured ScanVerdict, always defined
 */
export async function scanContent(ai: Ai, content: string): Promise<ScanVerdict> {
  try {
    const truncated = content.length > MAX_CONTENT_LENGTH
      ? content.slice(0, MAX_CONTENT_LENGTH)
      : content;

    const response = await ai.run(
      SCAN_MODEL as Parameters<typeof ai.run>[0],
      {
        messages: [
          { role: "system", content: SAFETY_SCAN_PROMPT },
          { role: "user", content: truncated },
        ],
        max_tokens: SCAN_MAX_TOKENS,
        temperature: SCAN_TEMPERATURE,
        stream: false,
      }
    );

    // Extract text from response
    let responseText = "";
    if (typeof response === "object" && response !== null) {
      const aiResponse = response as { response?: string };
      responseText = aiResponse.response ?? "";
    }

    if (!responseText) {
      return { ...DEFAULT_VERDICT, reason: "empty_response" };
    }

    const verdict = parseVerdict(responseText);
    if (!verdict) {
      return { ...DEFAULT_VERDICT, reason: "parse_error" };
    }

    return verdict;
  } catch {
    return { ...DEFAULT_VERDICT, reason: "scan_error" };
  }
}
