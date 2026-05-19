/**
 * Per-model price table (USD per 1M tokens).
 * Source: https://docs.claude.com/en/docs/about-claude/pricing
 *
 * If a model is missing, we fall back to Opus pricing so we err on the
 * side of over-counting cost rather than under-counting.
 */
export interface ModelPricing {
  input: number;
  output: number;
  cached_input?: number;
}

const TABLE: Record<string, ModelPricing> = {
  "claude-opus-4-7": { input: 15, output: 75, cached_input: 1.5 },
  "claude-opus-4-6": { input: 15, output: 75, cached_input: 1.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cached_input: 0.3 },
  "claude-sonnet-4-5": { input: 3, output: 15, cached_input: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cached_input: 0.1 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cached_input: 0.1 },
};

const FALLBACK = TABLE["claude-opus-4-7"]!;

export function getPricing(model: string): ModelPricing {
  return TABLE[model] ?? FALLBACK;
}

export function costFor(args: {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens?: number;
}): number {
  const p = getPricing(args.model);
  const uncachedIn = args.input_tokens - (args.cached_input_tokens ?? 0);
  return (
    (Math.max(uncachedIn, 0) * p.input) / 1_000_000 +
    ((args.cached_input_tokens ?? 0) * (p.cached_input ?? p.input)) / 1_000_000 +
    (args.output_tokens * p.output) / 1_000_000
  );
}
