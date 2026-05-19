import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { childLogger } from "../logger.js";
import { costFor } from "../pricing.js";

const log = childLogger({ component: "planner" });

const StepSchema = z.object({
  id: z.string(),
  title: z.string(),
  rationale: z.string().optional(),
  acceptance: z.string(),
  status: z.enum(["pending", "in_progress", "done", "blocked"]).default("pending"),
});

export const PlanSchema = z.object({
  goal: z.string(),
  steps: z.array(StepSchema).min(1).max(20),
});

export type Plan = z.infer<typeof PlanSchema>;
export type PlanStep = z.infer<typeof StepSchema>;

const PLAN_MODEL = "claude-sonnet-4-6";

const SYSTEM = `You are a senior tech-lead planner. Given a user task and (optionally) repository context, produce an ordered checklist that another agent will execute.

Each step must:
- be small enough to verify in isolation
- have an explicit acceptance criterion ("acceptance" field) — what evidence proves it's done
- avoid speculation about files you have not seen

Return ONLY JSON of the form:
{
  "goal": "...",
  "steps": [
    {"id":"s1","title":"...","rationale":"...","acceptance":"..."},
    ...
  ]
}`;

export async function buildPlan(args: {
  prompt: string;
  ragContext?: string;
}): Promise<{ plan: Plan; cost_usd: number }> {
  const cfg = loadConfig();
  const client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });
  const userParts: string[] = [`Task: ${args.prompt}`];
  if (args.ragContext) {
    userParts.push(`\nRepository context:\n${args.ragContext}`);
  }
  const resp = await client.messages.create({
    model: PLAN_MODEL,
    max_tokens: 2048,
    system: SYSTEM,
    messages: [{ role: "user", content: userParts.join("\n") }],
  });
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const plan = PlanSchema.parse(JSON.parse(extractJson(text)));
  // Re-set every status to pending in case the model invented some.
  plan.steps = plan.steps.map((s, i) => ({
    ...s,
    id: s.id || `s${i + 1}`,
    status: "pending",
  }));
  const cost = costFor({
    model: PLAN_MODEL,
    input_tokens: resp.usage.input_tokens,
    output_tokens: resp.usage.output_tokens,
  });
  log.info({ steps: plan.steps.length, cost_usd: cost }, "plan ready");
  return { plan, cost_usd: cost };
}

export function renderPlanForPrompt(plan: Plan): string {
  const lines = [`Plan goal: ${plan.goal}`, "", "Checklist:"];
  for (const s of plan.steps) {
    const box = s.status === "done" ? "[x]" : s.status === "blocked" ? "[!]" : "[ ]";
    lines.push(`${box} ${s.id}: ${s.title}`);
    if (s.acceptance) lines.push(`     accept: ${s.acceptance}`);
  }
  return lines.join("\n");
}

function extractJson(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) return fenced[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) return s.slice(start, end + 1);
  return s;
}
