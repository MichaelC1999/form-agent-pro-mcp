/**
 * USD per million tokens (Anthropic first-party API, Nov 2026).
 * Cache writes are billed at 1.25× input for the default 5-minute TTL.
 * Update this table when pricing or the model list changes.
 */
const PRICES_PER_MTOK: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  // Server-side refusal fallback target.
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

/** Unknown models are priced at the most expensive known rate, so spend estimates err high. */
const FALLBACK_PRICE = Object.values(PRICES_PER_MTOK).reduce((max, p) => (p.output > max.output ? p : max));

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const p = PRICES_PER_MTOK[model] ?? FALLBACK_PRICE;
  return (
    ((usage.inputTokens ?? 0) * p.input +
      (usage.outputTokens ?? 0) * p.output +
      (usage.cacheReadTokens ?? 0) * p.cacheRead +
      (usage.cacheCreationTokens ?? 0) * p.cacheWrite) /
    1_000_000
  );
}
