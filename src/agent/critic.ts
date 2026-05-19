import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { childLogger } from "../logger.js";
import { costFor } from "../pricing.js";

const log = childLogger({ component: "critic" });

export type CriticPersona = "linus" | "owasp" | "perf" | "junior";

const SYSTEMS: Record<CriticPersona, string> = {
  linus: `You are Linus Torvalds reviewing this change. You care about code quality: naming, complexity, duplication, dead code, idiomatic style. Be terse. Be cutting. Skip flattery.`,
  owasp: `You are an OWASP-certified security reviewer. You care about: secret leaks, injection (SQL, command, prompt), authn/authz gaps, unsafe deserialization, SSRF, IDOR, path traversal, dependency CVEs. Flag only real issues, not theoretical ones.`,
  perf: `You are Brendan Gregg reviewing performance. You care about: hot-path complexity, N+1 queries, blocking I/O on event loops, unbounded loops, missing pagination, memory allocations in tight loops.`,
  junior: `You are a six-month junior engineer reading this code. You flag anything that is hard to read, has confusing names, lacks any comments where intent isn't obvious, has too-clever one-liners, or assumes deep context that wasn't established.`,
};

const Verdict = z.object({
  pass: z.boolean(),
  issues: z.array(
    z.object({
      severity: z.enum(["info", "warn", "error"]),
      message: z.string(),
      file: z.string().optional(),
      line: z.number().int().optional(),
    }),
  ),
});

export type Verdict = z.infer<typeof Verdict>;
export interface CriticResult {
  persona: CriticPersona;
  verdict: Verdict;
  cost_usd: number;
}

const REVIEW_MODEL = "claude-sonnet-4-6";

/**
 * Run all four critic personas in parallel against the proposed change.
 * `diff` is the unified-diff text of what the agent has written so far;
 * `summary` is the agent's own end-of-run summary.
 */
export async function runCritics(args: {
  diff: string;
  summary: string;
  prompt: string;
}): Promise<CriticResult[]> {
  const personas: CriticPersona[] = ["linus", "owasp", "perf", "junior"];
  return Promise.all(personas.map((p) => runOne(p, args)));
}

async function runOne(
  persona: CriticPersona,
  args: { diff: string; summary: string; prompt: string },
): Promise<CriticResult> {
  const cfg = loadConfig();
  const client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });
  const user = `Original task:
${args.prompt}

Agent's self-reported summary:
${args.summary}

Unified diff of changes:
\`\`\`diff
${args.diff.slice(0, 60_000)}
\`\`\`

Return ONLY JSON: {"pass": bool, "issues": [{"severity":"info|warn|error","message":"...","file":"...","line":N}, ...]}.
Pass = true only if there are no warn/error severity issues you would block on.`;

  try {
    const resp = await client.messages.create({
      model: REVIEW_MODEL,
      max_tokens: 2048,
      system: SYSTEMS[persona],
      messages: [{ role: "user", content: user }],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    const verdict = Verdict.parse(JSON.parse(extractJson(text)));
    const cost = costFor({
      model: REVIEW_MODEL,
      input_tokens: resp.usage.input_tokens,
      output_tokens: resp.usage.output_tokens,
    });
    return { persona, verdict, cost_usd: cost };
  } catch (err) {
    log.warn({ persona, err: (err as Error).message }, "critic failed; passing");
    return { persona, verdict: { pass: true, issues: [] }, cost_usd: 0 };
  }
}

function extractJson(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) return fenced[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) return s.slice(start, end + 1);
  return s;
}

/** Aggregate critic results into a single human-readable Markdown block. */
export function formatCriticReport(results: CriticResult[]): string {
  const lines: string[] = ["## Self-critique"];
  for (const r of results) {
    const status = r.verdict.pass ? "✅" : "❌";
    lines.push(`\n### ${status} ${r.persona}`);
    if (r.verdict.issues.length === 0) {
      lines.push("_no issues_");
    } else {
      for (const i of r.verdict.issues) {
        const loc = i.file ? ` (${i.file}${i.line ? `:${i.line}` : ""})` : "";
        lines.push(`- **${i.severity}**${loc} — ${i.message}`);
      }
    }
  }
  return lines.join("\n");
}

export function shouldRevise(results: CriticResult[]): boolean {
  for (const r of results) {
    if (!r.verdict.pass) return true;
    for (const i of r.verdict.issues) {
      if (i.severity === "error" || i.severity === "warn") return true;
    }
  }
  return false;
}
