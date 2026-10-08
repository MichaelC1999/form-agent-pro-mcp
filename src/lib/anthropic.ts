import Anthropic from "@anthropic-ai/sdk";
import { ClaudeContentError } from "../models/AppError";

let _client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable is not set");
    }
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

/**
 * Model for every pipeline call. Thinking is always on for this model (it
 * can't be disabled) and its default effort is "medium", so each call sets
 * output_config.effort explicitly.
 */
export const CLAUDE_MODEL = "claude-opus-5-5";

/**
 * Server-side refusal fallback, spread into a client.beta.messages request: if
 * the model's safety classifiers decline, the API re-runs the same request on
 * Claude Opus 5 within the same call. Array form — the one SDK 0.111 types.
 */
export const REFUSAL_FALLBACK = {
  betas: ["server-side-fallback-2026-06-01"],
  fallbacks: [{ model: "claude-opus-5" }],
};

/** The refusal on a response whose whole fallback chain declined, or null. */
export function getRefusal(response: Anthropic.Beta.BetaMessage): { category: string; explanation: string } | null {
  if (response.stop_reason !== "refusal") return null;
  return {
    category: response.stop_details?.category ?? "unspecified",
    explanation: response.stop_details?.explanation ?? "The model declined this request.",
  };
}

/** Throws a ClaudeContentError (code "refusal") when every model in the fallback chain declined. */
export function throwIfRefused(response: Anthropic.Beta.BetaMessage, service: string): void {
  const refusal = getRefusal(response);
  if (refusal) {
    throw new ClaudeContentError({
      service,
      code: "refusal",
      message: refusal.explanation,
      details: `Refusal category: ${refusal.category}`,
    });
  }
}
