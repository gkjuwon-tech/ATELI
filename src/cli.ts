#!/usr/bin/env node
import { Command } from "commander";
import { runAgent } from "./agent/runner.js";
import { listMessages, listTasks, listToolCalls, getTask } from "./storage/tasks.js";
import { loadConfig } from "./config.js";
import { indexRepo } from "./rag/indexer.js";
import { startWorker } from "./worker.js";
import { issueToken, listTokens, revokeToken, type Scope } from "./storage/tokens.js";
import { listSessions } from "./storage/sessions.js";

const program = new Command();
program
  .name("ateli")
  .description("ateli — hi-end AI software engineering agent")
  .version("0.2.0");

program
  .command("run")
  .description("Run an agent task against a workspace")
  .argument("<prompt>", "Task description (in quotes)")
  .option("-w, --workspace <path>", "Workspace directory the agent operates on", process.cwd())
  .option("--session <id>", "Continue an existing session")
  .option("--user <id>", "User id for personalization / auditing")
  .option("--tier <tier>", "Force tier: trivial | medium | complex | architectural")
  .option("--model <model>", "Force a specific Anthropic model id")
  .option("--budget <usd>", "Per-task budget cap in USD")
  .option("--plan", "Generate a checklist first (plan→execute)", false)
  .option("--no-critique", "Disable self-critique pass")
  .option("--quiet", "Suppress streaming event output", false)
  .action(async (
    prompt: string,
    options: {
      workspace: string;
      session?: string;
      user?: string;
      tier?: string;
      model?: string;
      budget?: string;
      plan?: boolean;
      critique?: boolean;
      quiet: boolean;
    },
  ) => {
    try {
      loadConfig();
      const result = await runAgent({
        prompt,
        workspace: options.workspace,
        source: "cli",
        session_id: options.session,
        user_id: options.user,
        force_tier: options.tier as never,
        force_model: options.model,
        budget_usd: options.budget ? Number(options.budget) : undefined,
        plan_mode: options.plan,
        critique: options.critique,
        onEvent: options.quiet ? undefined : (e) => printEvent(e),
      });
      if (options.quiet) {
        process.stdout.write(result.finalText + "\n");
      } else {
        process.stdout.write(
          `\n[task ${result.task.id}] ${result.task.status} — ` +
            `${result.task.input_tokens} in / ${result.task.output_tokens} out, ` +
            `$${result.task.cost_usd.toFixed(4)}\n`,
        );
      }
    } catch (err) {
      process.stderr.write(`ateli: ${msgOf(err)}\n`);
      process.exit(1);
    }
  });

program
  .command("tasks")
  .description("List recent tasks")
  .option("-n, --limit <n>", "Max rows", "20")
  .action((opts: { limit: string }) => {
    for (const t of listTasks(Number(opts.limit))) {
      const when = new Date(t.created_at).toISOString();
      process.stdout.write(
        `${t.id}\t${t.status.padEnd(10)}\t${when}\t$${t.cost_usd.toFixed(4)}\t${truncate(t.prompt, 60)}\n`,
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
        `Cost: $${task.cost_usd.toFixed(4)}\n` +
        `Session: ${task.session_id ?? "(none)"}\n` +
        (task.error ? `Error: ${task.error}\n` : "") +
        `---\n`,
    );
    for (const m of listMessages(task.id)) {
      process.stdout.write(`[${m.role}]\n${m.content}\n---\n`);
    }
    process.stdout.write(`Tool calls:\n`);
    for (const c of listToolCalls(task.id)) {
      process.stdout.write(
        `  #${c.id} turn ${c.turn} ${c.tool_name} (${c.duration_ms ?? "?"}ms, err=${c.is_error})\n`,
      );
    }
  });

program
  .command("index")
  .description("Index a repo for RAG retrieval (real Voyage AI embeddings)")
  .requiredOption("--repo-id <id>", "Logical repo identifier")
  .requiredOption("--path <path>", "Local path to the repo on disk")
  .action(async (opts: { repoId: string; path: string }) => {
    try {
      loadConfig();
      const stats = await indexRepo({ repoId: opts.repoId, repoRoot: opts.path });
      process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
    } catch (err) {
      process.stderr.write(`ateli: ${msgOf(err)}\n`);
      process.exit(1);
    }
  });

program
  .command("serve")
  .description("Start the ateli HTTP API + web dashboard")
  .action(async () => {
    try {
      loadConfig();
      await import("./server.js");
    } catch (err) {
      process.stderr.write(`ateli: ${msgOf(err)}\n`);
      process.exit(1);
    }
  });

program
  .command("slack")
  .description("Start the ateli Slack bot (socket mode)")
  .action(async () => {
    try {
      loadConfig();
      await import("./surfaces/slack/start.js");
    } catch (err) {
      process.stderr.write(`ateli: ${msgOf(err)}\n`);
      process.exit(1);
    }
  });

program
  .command("worker")
  .description("Start a background worker that processes the durable job queue")
  .option("-c, --concurrency <n>", "Max concurrent jobs", "1")
  .action(async (opts: { concurrency: string }) => {
    try {
      loadConfig();
      const w = startWorker({ concurrency: Number(opts.concurrency) });
      process.on("SIGINT", async () => {
        await w.stop();
        process.exit(0);
      });
      process.on("SIGTERM", async () => {
        await w.stop();
        process.exit(0);
      });
    } catch (err) {
      process.stderr.write(`ateli: ${msgOf(err)}\n`);
      process.exit(1);
    }
  });

const tokenCmd = program.command("token").description("Manage API tokens");

tokenCmd
  .command("create")
  .description("Issue a new API token (prints plaintext exactly once)")
  .requiredOption("--user <id>", "User id this token belongs to")
  .requiredOption("--name <name>", "Human-readable name")
  .option("--scope <scope>", "read | write | admin", "write")
  .action((opts: { user: string; name: string; scope: string }) => {
    const scope = opts.scope as Scope;
    if (!["read", "write", "admin"].includes(scope)) {
      process.stderr.write("scope must be one of read|write|admin\n");
      process.exit(1);
    }
    const t = issueToken({ user_id: opts.user, name: opts.name, scope });
    process.stdout.write(
      `${t.plaintext}\n\nThis token is shown once. Store it now.\n` +
        `  id:    ${t.id}\n` +
        `  user:  ${opts.user}\n` +
        `  scope: ${scope}\n`,
    );
  });

tokenCmd
  .command("list")
  .description("List tokens")
  .option("--user <id>", "Filter by user")
  .action((opts: { user?: string }) => {
    for (const t of listTokens(opts.user)) {
      process.stdout.write(
        `${t.id}\t${t.scope.padEnd(6)}\t${t.user_id}\t${t.name}` +
          (t.revoked_at ? "\t(revoked)" : "") +
          "\n",
      );
    }
  });

tokenCmd
  .command("revoke <id>")
  .description("Revoke a token")
  .action((id: string) => {
    revokeToken(id);
    process.stdout.write(`revoked ${id}\n`);
  });

program
  .command("sessions")
  .description("List recent sessions")
  .option("-n, --limit <n>", "Max rows", "20")
  .action((opts: { limit: string }) => {
    for (const s of listSessions(Number(opts.limit))) {
      const when = new Date(s.updated_at).toISOString();
      process.stdout.write(
        `${s.id}\t${s.source}\t${s.source_ref ?? "-"}\t${when}\n`,
      );
    }
  });

function printEvent(e: import("./agent/runner.js").AgentEvent) {
  switch (e.type) {
    case "task_created":
      process.stdout.write(`▶ task ${e.task.id} (${e.task.model})\n`);
      break;
    case "routed":
      process.stdout.write(`[router] tier=${e.tier} model=${e.model} — ${e.rationale}\n`);
      break;
    case "plan":
      process.stdout.write(`[plan] ${e.plan.steps.length} steps:\n`);
      for (const s of e.plan.steps) process.stdout.write(`  - ${s.id}: ${s.title}\n`);
      break;
    case "turn_started":
      process.stdout.write(`\n--- turn ${e.turn} ---\n`);
      break;
    case "assistant_text":
      process.stdout.write(e.text);
      break;
    case "tool_call":
      process.stdout.write(`\n[tool] ${e.tool_name} ${JSON.stringify(e.input)}\n`);
      break;
    case "tool_result":
      process.stdout.write(
        `[result${e.is_error ? " ERR" : ""} ${e.duration_ms}ms] ${truncate(e.output, 400)}\n`,
      );
      break;
    case "usage":
      process.stdout.write(
        `\n[usage ${e.input_tokens} in / ${e.output_tokens} out — $${e.cost_usd.toFixed(4)}]\n`,
      );
      break;
    case "interject":
      process.stdout.write(`\n[interject turn ${e.turn}] ${e.text}\n`);
      break;
    case "budget_warn":
      process.stdout.write(
        `\n[budget] 80%+ used: $${e.spent_usd.toFixed(4)} / $${e.budget_usd.toFixed(2)}\n`,
      );
      break;
    case "budget_exceeded":
      process.stdout.write(
        `\n[budget EXCEEDED] $${e.spent_usd.toFixed(4)} / $${e.budget_usd.toFixed(2)} — stopping\n`,
      );
      break;
    case "critique": {
      process.stdout.write(`\n[critique]\n`);
      for (const r of e.results) {
        const ok = r.verdict.pass ? "✓" : "✗";
        process.stdout.write(`  ${ok} ${r.persona}: ${r.verdict.issues.length} issue(s)\n`);
      }
      break;
    }
    case "task_finished":
      break;
  }
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : one.slice(0, n - 1) + "…";
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`ateli: ${msgOf(err)}\n`);
  process.exit(1);
});
