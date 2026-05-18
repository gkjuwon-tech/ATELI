#!/usr/bin/env node
import { Command } from "commander";
import { runAgent } from "./agent/runner.js";
import { listMessages, listTasks, listToolCalls, getTask } from "./storage/tasks.js";
import { loadConfig } from "./config.js";

const program = new Command();
program
  .name("ateli")
  .description("ateli — hi-end AI software engineering agent")
  .version("0.1.0");

program
  .command("run")
  .description("Run an agent task against a workspace")
  .argument("<prompt>", "Task description (in quotes)")
  .option(
    "-w, --workspace <path>",
    "Workspace directory the agent operates on",
    process.cwd(),
  )
  .option("--quiet", "Suppress streaming event output", false)
  .action(async (prompt: string, options: { workspace: string; quiet: boolean }) => {
    try {
      loadConfig();
      const result = await runAgent({
        prompt,
        workspace: options.workspace,
        source: "cli",
        onEvent: options.quiet ? undefined : (e) => printEvent(e),
      });
      if (options.quiet) {
        process.stdout.write(result.finalText + "\n");
      } else {
        process.stdout.write(
          `\n[task ${result.task.id}] ${result.task.status} — ` +
            `${result.task.input_tokens} in / ${result.task.output_tokens} out tokens\n`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`ateli: ${msg}\n`);
      process.exit(1);
    }
  });

program
  .command("tasks")
  .description("List recent tasks")
  .option("-n, --limit <n>", "Max rows", "20")
  .action((opts: { limit: string }) => {
    const rows = listTasks(Number(opts.limit));
    for (const t of rows) {
      const when = new Date(t.created_at).toISOString();
      process.stdout.write(
        `${t.id}\t${t.status.padEnd(10)}\t${when}\t${truncate(t.prompt, 60)}\n`,
      );
    }
  });

program
  .command("show")
  .description("Show the message + tool-call log for a task")
  .argument("<id>", "Task ID")
  .action((id: string) => {
    const task = getTask(id);
    if (!task) {
      process.stderr.write(`no such task: ${id}\n`);
      process.exit(1);
    }
    process.stdout.write(
      `Task ${task.id}\nStatus: ${task.status}\nModel: ${task.model}\n` +
        `Workspace: ${task.workspace}\nPrompt: ${task.prompt}\n` +
        `Tokens: ${task.input_tokens} in / ${task.output_tokens} out\n` +
        (task.error ? `Error: ${task.error}\n` : "") +
        `---\n`,
    );
    const msgs = listMessages(task.id);
    for (const m of msgs) {
      process.stdout.write(`[${m.role}]\n${m.content}\n---\n`);
    }
    process.stdout.write(`Tool calls:\n`);
    for (const c of listToolCalls(task.id)) {
      process.stdout.write(
        `  #${c.id} turn ${c.turn} ${c.tool_name} (${c.duration_ms ?? "?"}ms, err=${c.is_error})\n`,
      );
    }
  });

function printEvent(e: import("./agent/runner.js").AgentEvent) {
  switch (e.type) {
    case "task_created":
      process.stdout.write(`▶ task ${e.task.id} (${e.task.model})\n`);
      break;
    case "turn_started":
      process.stdout.write(`\n--- turn ${e.turn} ---\n`);
      break;
    case "assistant_text":
      process.stdout.write(e.text);
      break;
    case "tool_call":
      process.stdout.write(
        `\n[tool] ${e.tool_name} ${JSON.stringify(e.input)}\n`,
      );
      break;
    case "tool_result":
      process.stdout.write(
        `[result${e.is_error ? " ERR" : ""} ${e.duration_ms}ms] ${truncate(e.output, 400)}\n`,
      );
      break;
    case "usage":
      process.stdout.write(
        `\n[usage ${e.input_tokens} in / ${e.output_tokens} out]\n`,
      );
      break;
    case "task_finished":
      // printed by run command
      break;
  }
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= n ? oneLine : oneLine.slice(0, n - 1) + "…";
}

program.parseAsync(process.argv).catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`ateli: ${msg}\n`);
  process.exit(1);
});
