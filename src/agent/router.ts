import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { childLogger } from "../logger.js";

const log = childLogger({ component: "router" });

export type TaskTier = "trivial" | "medium" | "complex" | "architectural";

export interface RoutedPlan {
  tier: TaskTier;
  model: string;
  max_tokens: number;
  thinking: { type: "enabled"; budget_tokens: number } | undefined;
  rationale: string;
}

export interface RouterOverrides {
  /** Force a specific model regardless of classification. */
  force_model?: string;
  /** Force the tier (skips the classifier call). */
  force_tier?: TaskTier;
}

const Tiers = z.object({
  tier: z.enum(["trivial", "medium", "complex", "architectural"]),
  rationale: z.string(),
});

const CLASSIFIER_MODEL = "claude-haiku-4-5";
const CLASSIFIER_SYSTEM = `You are a routing classifier for ateli (a software-engineering agent).
Pick exactly one tier for the user's task:

- trivial: one-line edits, comments, formatting, import sorting, README typo fixes.
- medium: single-function changes, adding a simple endpoint, fixing a small bug with a clear repro.
- complex: multi-file changes, non-trivial refactors, new features that touch several modules.
- architectural: cross-cutting changes (auth, data model, migration), system-level design choices.

Return ONLY valid JSON of the form {"tier": "...", "rationale": "..."}.`;

const ROUTING: Record<TaskTier, Omit<RoutedPlan, "tier" | "rationale">> = {
  trivial: {
    model: "claude-haiku-4-5",
    max_tokens: 2048,
    thinking: undefined,
  },
  medium: {
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    thinking: undefined,
  },
  complex: {
    model: "claude-opus-4-7",
    max_tokens: 8192,
    thinking: undefined,
  },
  architectural: {
    model: "claude-opus-4-7",
    max_tokens: 16384,
    thinking: { type: "enabled", budget_tokens: 8192 },
  },
};

/**
 * Pick a model + sampling params for a task by asking Haiku to classify it.
 * Falls back to a defensive "complex" tier on any error so we never under-spec.
 */
export async function route(
  prompt: string,
  overrides: RouterOverrides = {},
): Promise<RoutedPlan> {
  if (overrides.force_tier) {
    const plan = ROUTING[overrides.force_tier];
    return {
      tier: overrides.force_tier,
      model: overrides.force_model ?? plan.model,
      max_tokens: plan.max_tokens,
      thinking: plan.thinking,
      rationale: `forced tier=${overrides.force_tier}`,
    };
  }

  let tier: TaskTier = "complex";
  let rationale = "default";
  try {
    const cfg = loadConfig();
    const client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 256,
      system: CLASSIFIER_SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    const json = extractJson(text);
    const parsed = Tiers.parse(JSON.parse(json));
    tier = parsed.tier;
    rationale = parsed.rationale;
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      "classifier failed; falling back to complex",
    );
  }

  const plan = ROUTING[tier];
  return {
    tier,
    model: overrides.force_model ?? plan.model,
    max_tokens: plan.max_tokens,
    thinking: plan.thinking,
    rationale,
  };
}

function extractJson(s: string): string {
  // Tolerate ```json fences around the response.
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) return fenced[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) return s.slice(start, end + 1);
  return s;
}
