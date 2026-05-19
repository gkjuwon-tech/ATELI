import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../config.js";
import { childLogger } from "../logger.js";
import { Workspace } from "../workspace/workspace.js";
import { executeTool } from "../tools/index.js";
import {
  addTaskCost,
  addTaskTokens,
  appendMessage,
  createTask,
  finishToolCall,
  getTask,
  recordToolCall,
  setTaskPlan,
  takeTaskInterject,
  updateTaskStatus,
  type Task,
} from "../storage/tasks.js";
import {
  createSession,
  findOrCreateSessionByRef,
  getSession,
  listSessionMessages,
  setSessionSummary,
  touchSession,
} from "../storage/sessions.js";
import { systemPrompt } from "./prompts.js";
import { TOOL_DEFINITIONS } from "./tools.js";
import { eventBus } from "../events/bus.js";
import { route, type TaskTier } from "./router.js";
import { costFor } from "../pricing.js";
import { formatCriticReport, runCritics, shouldRevise, type CriticResult } from "./critic.js";
import { buildPlan, renderPlanForPrompt, type Plan } from "./planner.js";
import { getProfile, profileForPrompt } from "./style.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface RunOptions {
  prompt: string;
  workspace: string;
  source?: string;
  source_ref?: string;
  user_id?: string;
  /** Use this session (multi-turn). Created if not present. */
  session_id?: string;
  /** Force a specific tier (skip the classifier). */
  force_tier?: TaskTier;
  /** Force a specific model. */
  force_model?: string;
  /** Per-task USD budget. If undefined, falls back to ATELI_BUDGET_PER_TASK_USD. */
  budget_usd?: number;
  /** Generate + execute a plan instead of one-shot. */
  plan_mode?: boolean;
  /** Run self-critique after the agent finishes (default true for complex+). */
  critique?: boolean;
  ragContext?: string;
  onEvent?: (event: AgentEvent) => void;
}

export type AgentEvent =
  | { type: "task_created"; task: Task }
  | { type: "routed"; tier: TaskTier; model: string; rationale: string }
  | { type: "plan"; plan: Plan }
  | { type: "turn_started"; turn: number }
  | { type: "assistant_text"; turn: number; text: string }
  | {
      type: "tool_call";
      turn: number;
      tool_name: string;
      tool_use_id: string;
      input: unknown;
    }
  | {
      type: "tool_result";
      turn: number;
      tool_use_id: string;
      output: string;
      is_error: boolean;
      duration_ms: number;
    }
  | {
      type: "usage";
      turn: number;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    }
  | { type: "interject"; turn: number; text: string }
  | { type: "budget_warn"; spent_usd: number; budget_usd: number }
  | { type: "budget_exceeded"; spent_usd: number; budget_usd: number }
  | { type: "critique"; results: CriticResult[] }
  | { type: "task_finished"; task: Task };

export interface RunResult {
  task: Task;
  finalText: string;
  critique?: CriticResult[];
}

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const cfg = loadConfig();
  const ws = new Workspace(opts.workspace);
  const log = childLogger({ component: "agent", workspace: ws.root });

  // ---- session resolution ----
  let sessionId: string | null = null;
  if (opts.session_id) {
    sessionId =
      getSession(opts.session_id)?.id ??
      createSession({
        source: opts.source ?? "cli",
        source_ref: opts.source_ref,
        user_id: opts.user_id,
      }).id;
  } else if (opts.source && opts.source_ref) {
    sessionId = findOrCreateSessionByRef({
      source: opts.source,
      source_ref: opts.source_ref,
      user_id: opts.user_id,
    }).id;
  }

  // ---- routing ----
  const routed = await route(opts.prompt, {
    force_model: opts.force_model,
    force_tier: opts.force_tier,
  });

  // ---- task row ----
  const task = createTask({
    workspace: ws.root,
    prompt: opts.prompt,
    model: routed.model,
    source: opts.source,
    source_ref: opts.source_ref,
    session_id: sessionId ?? undefined,
    user_id: opts.user_id,
  });
  const emit = (event: AgentEvent) => {
    opts.onEvent?.(event);
    eventBus.publish(task.id, event);
  };
  emit({ type: "task_created", task });
  emit({
    type: "routed",
    tier: routed.tier,
    model: routed.model,
    rationale: routed.rationale,
  });
  log.info({ task_id: task.id, tier: routed.tier, model: routed.model }, "task routed");

  updateTaskStatus(task.id, "running");
  appendMessage(task.id, "user", opts.prompt);

  // ---- optional plan ----
  let plan: Plan | null = null;
  if (opts.plan_mode) {
    try {
      const built = await buildPlan({
        prompt: opts.prompt,
        ragContext: opts.ragContext,
      });
      plan = built.plan;
      setTaskPlan(task.id, plan);
      addTaskCost(task.id, built.cost_usd);
      emit({ type: "plan", plan });
    } catch (err) {
      log.warn({ err: (err as Error).message }, "planning failed; continuing without plan");
    }
  }

  // ---- compose system prompt ----
  const profile = opts.user_id ? getProfile(opts.user_id) : null;
  const session = sessionId ? getSession(sessionId) : null;
  const baseSystem = systemPrompt({
    workspaceRoot: ws.root,
    ragContext: opts.ragContext,
  });
  const styleBlock = profileForPrompt(profile);
  const planBlock = plan ? `Active plan:\n${renderPlanForPrompt(plan)}` : "";
  const summaryBlock = session?.summary
    ? `Prior session summary:\n${session.summary}`
    : "";
  const system = [baseSystem, styleBlock, planBlock, summaryBlock]
    .filter((s) => s.trim().length > 0)
    .join("\n\n");

  const client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });

  // ---- prior session history (multi-turn) ----
  const messages: Anthropic.MessageParam[] = [];
  if (sessionId) {
    const prior = listSessionMessages(sessionId, task.id);
    for (const m of prior) {
      const role = m.role === "assistant" ? "assistant" : "user";
      try {
        const parsed = JSON.parse(m.content);
        messages.push({ role, content: parsed });
      } catch {
        messages.push({ role, content: m.content });
      }
    }
  }
  messages.push({ role: "user", content: opts.prompt });

  // ---- budget ----
  const budget = opts.budget_usd ?? Number(process.env.ATELI_BUDGET_PER_TASK_USD ?? 0);
  let spent = 0;
  let budgetWarned = false;

  let finalText = "";
  let turn = 0;
  let finishReason: string | null = null;

  try {
    while (turn < cfg.ATELI_MAX_TURNS) {
      turn++;
      emit({ type: "turn_started", turn });
      log.debug({ turn }, "turn start");

      const interject = takeTaskInterject(task.id);
      if (interject) {
        messages.push({ role: "user", content: `[user interject] ${interject}` });
        appendMessage(task.id, "user", `[interject] ${interject}`);
        emit({ type: "interject", turn, text: interject });
      }

      const response = await client.messages.create({
        model: routed.model,
        max_tokens: routed.max_tokens,
        ...(routed.thinking ? { thinking: routed.thinking } : {}),
        system,
        tools: TOOL_DEFINITIONS,
        messages,
      });

      addTaskTokens(task.id, response.usage.input_tokens, response.usage.output_tokens);
      const turnCost = costFor({
        model: routed.model,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      });
      addTaskCost(task.id, turnCost);
      spent += turnCost;
      emit({
        type: "usage",
        turn,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cost_usd: turnCost,
      });

      if (budget > 0) {
        if (!budgetWarned && spent >= budget * 0.8) {
          budgetWarned = true;
          emit({ type: "budget_warn", spent_usd: spent, budget_usd: budget });
        }
        if (spent >= budget) {
          emit({ type: "budget_exceeded", spent_usd: spent, budget_usd: budget });
          finishReason = "budget_exceeded";
          break;
        }
      }

      messages.push({ role: "assistant", content: response.content });
      appendMessage(task.id, "assistant", response.content);

      const toolUses: Anthropic.ToolUseBlock[] = [];
      let turnText = "";
      for (const block of response.content) {
        if (block.type === "text") {
          turnText += block.text;
          emit({ type: "assistant_text", turn, text: block.text });
        } else if (block.type === "tool_use") {
          toolUses.push(block);
        }
      }
      if (turnText) finalText = turnText;

      if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
        finishReason = response.stop_reason ?? "end_turn";
        break;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const callRowId = recordToolCall({
          task_id: task.id,
          turn,
          tool_use_id: use.id,
          tool_name: use.name,
          input: use.input,
        });
        emit({
          type: "tool_call",
          turn,
          tool_name: use.name,
          tool_use_id: use.id,
          input: use.input,
        });

        const started = Date.now();
        const result = await executeTool(use.name, use.input, ws);
        const duration = Date.now() - started;

        finishToolCall({
          id: callRowId,
          output: result.output,
          is_error: result.is_error,
          duration_ms: duration,
        });
        emit({
          type: "tool_result",
          turn,
          tool_use_id: use.id,
          output: result.output,
          is_error: result.is_error,
          duration_ms: duration,
        });

        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: result.output,
          is_error: result.is_error,
        });
      }

      messages.push({ role: "user", content: toolResults });
      appendMessage(task.id, "tool_results", toolResults);
    }

    if (turn >= cfg.ATELI_MAX_TURNS && finishReason === null) {
      finishReason = "max_turns_reached";
    }

    // ---- self-critique ----
    let criticResults: CriticResult[] | undefined;
    const wantCritique =
      opts.critique ??
      (routed.tier === "complex" || routed.tier === "architectural");
    if (wantCritique && finishReason !== "budget_exceeded") {
      try {
        const diff = await collectDiff(ws.root);
        if (diff.trim().length > 0) {
          criticResults = await runCritics({
            diff,
            summary: finalText,
            prompt: opts.prompt,
          });
          for (const r of criticResults) addTaskCost(task.id, r.cost_usd);
          emit({ type: "critique", results: criticResults });

          const withinBudget = !budget || spent < budget * 0.9;
          if (shouldRevise(criticResults) && withinBudget) {
            const feedback = formatCriticReport(criticResults);
            messages.push({
              role: "user",
              content: `[self-critique feedback — please address the warn/error items, then stop]\n${feedback}`,
            });
            appendMessage(task.id, "user", `[critique] ${feedback}`);
            const revise = await client.messages.create({
              model: routed.model,
              max_tokens: routed.max_tokens,
              system,
              tools: TOOL_DEFINITIONS,
              messages,
            });
            const reviseCost = costFor({
              model: routed.model,
              input_tokens: revise.usage.input_tokens,
              output_tokens: revise.usage.output_tokens,
            });
            addTaskCost(task.id, reviseCost);
            addTaskTokens(task.id, revise.usage.input_tokens, revise.usage.output_tokens);
            for (const block of revise.content) {
              if (block.type === "text") finalText = block.text;
            }
            appendMessage(task.id, "assistant", revise.content);
          }
        }
      } catch (err) {
        log.warn({ err: (err as Error).message }, "critique step failed");
      }
    }

    updateTaskStatus(task.id, "succeeded", {
      finish_reason: finishReason ?? "end_turn",
    });

    if (sessionId) {
      touchSession(sessionId, task.id);
      if (finalText) setSessionSummary(sessionId, finalText.slice(0, 4000));
    }

    const final = getTask(task.id)!;
    emit({ type: "task_finished", task: final });
    log.info(
      {
        task_id: task.id,
        turns: turn,
        cost_usd: final.cost_usd,
        finish_reason: finishReason,
      },
      "task finished",
    );
    return { task: final, finalText, critique: criticResults };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateTaskStatus(task.id, "failed", { error: msg });
    const final = getTask(task.id)!;
    emit({ type: "task_finished", task: final });
    log.error({ task_id: task.id, err: msg }, "task failed");
    throw err;
  }
}

/**
 * Unified-diff of every workspace change including untracked files.
 * Returns "" if not a git repo or git is missing.
 */
async function collectDiff(root: string): Promise<string> {
  try {
    const tracked = (
      await execFileP("git", ["diff", "HEAD"], { cwd: root, maxBuffer: 50 * 1024 * 1024 })
    ).stdout;
    const untracked = (
      await execFileP("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root })
    ).stdout
      .split("\n")
      .filter(Boolean);
    let extra = "";
    for (const f of untracked.slice(0, 30)) {
      try {
        const out = (
          await execFileP("git", ["diff", "--no-index", "/dev/null", f], {
            cwd: root,
            maxBuffer: 5 * 1024 * 1024,
          })
        ).stdout;
        extra += out;
      } catch (e: unknown) {
        const stdout = (e as { stdout?: string }).stdout;
        if (stdout) extra += stdout;
      }
    }
    return tracked + extra;
  } catch {
    return "";
  }
}
