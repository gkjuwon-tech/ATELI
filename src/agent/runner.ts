import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../config.js";
import { childLogger } from "../logger.js";
import { Workspace } from "../workspace/workspace.js";
import { executeTool } from "../tools/index.js";
import {
  addTaskTokens,
  appendMessage,
  createTask,
  finishToolCall,
  recordToolCall,
  updateTaskStatus,
  type Task,
} from "../storage/tasks.js";
import { systemPrompt } from "./prompts.js";
import { TOOL_DEFINITIONS } from "./tools.js";
import { eventBus } from "../events/bus.js";

export interface RunOptions {
  prompt: string;
  workspace: string;
  source?: string;
  source_ref?: string;
  ragContext?: string;
  onEvent?: (event: AgentEvent) => void;
}

export type AgentEvent =
  | { type: "task_created"; task: Task }
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
    }
  | { type: "task_finished"; task: Task };

export interface RunResult {
  task: Task;
  finalText: string;
}

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const cfg = loadConfig();
  const ws = new Workspace(opts.workspace);
  const log = childLogger({ component: "agent", workspace: ws.root });

  const task = createTask({
    workspace: ws.root,
    prompt: opts.prompt,
    model: cfg.ATELI_MODEL,
    source: opts.source,
    source_ref: opts.source_ref,
  });
  const emit = (event: AgentEvent) => {
    opts.onEvent?.(event);
    eventBus.publish(task.id, event);
  };
  emit({ type: "task_created", task });
  log.info({ task_id: task.id }, "task created");

  updateTaskStatus(task.id, "running");
  appendMessage(task.id, "user", opts.prompt);

  const client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });
  const system = systemPrompt({
    workspaceRoot: ws.root,
    ragContext: opts.ragContext,
  });

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: opts.prompt },
  ];

  let finalText = "";
  let turn = 0;
  let finishReason: string | null = null;

  try {
    while (turn < cfg.ATELI_MAX_TURNS) {
      turn++;
      emit({ type: "turn_started", turn });
      log.debug({ turn }, "turn start");

      const response = await client.messages.create({
        model: cfg.ATELI_MODEL,
        max_tokens: cfg.ATELI_MAX_TOKENS,
        system,
        tools: TOOL_DEFINITIONS,
        messages,
      });

      addTaskTokens(
        task.id,
        response.usage.input_tokens,
        response.usage.output_tokens,
      );
      emit({
        type: "usage",
        turn,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      });

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
        log.debug(
          { tool: use.name, duration_ms: duration, is_error: result.is_error },
          "tool executed",
        );

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

    updateTaskStatus(task.id, "succeeded", {
      finish_reason: finishReason ?? "end_turn",
    });
    const final = (await import("../storage/tasks.js")).getTask(task.id)!;
    emit({ type: "task_finished", task: final });
    log.info(
      { task_id: task.id, turns: turn, finish_reason: finishReason },
      "task finished",
    );
    return { task: final, finalText };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateTaskStatus(task.id, "failed", { error: msg });
    const final = (await import("../storage/tasks.js")).getTask(task.id)!;
    emit({ type: "task_finished", task: final });
    log.error({ task_id: task.id, err: msg }, "task failed");
    throw err;
  }
}
