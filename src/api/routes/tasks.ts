import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { runAgent, type AgentEvent } from "../../agent/runner.js";
import {
  getTask,
  listMessages,
  listTasks,
  listToolCalls,
} from "../../storage/tasks.js";
import { eventBus } from "../../events/bus.js";
import { childLogger } from "../../logger.js";
import { cloneRepo } from "../../surfaces/github/clone.js";
import { commitAndOpenPr } from "../../surfaces/github/pr.js";
import { retrieve, formatForPrompt } from "../../rag/retriever.js";

const log = childLogger({ component: "api/tasks" });

const CreateTask = z.object({
  prompt: z.string().min(1),
  workspace: z.string().optional(),
  repo: z.string().regex(/^[^/]+\/[^/]+$/).optional(),
  base: z.string().optional(),
  rag_repo: z.string().optional(),
}).refine((v) => !!v.workspace || !!v.repo, {
  message: "either `workspace` or `repo` is required",
});

export const tasksRouter = new Hono();

tasksRouter.get("/", (c) => {
  const limit = Number(c.req.query("limit") ?? "50");
  return c.json({ tasks: listTasks(limit) });
});

tasksRouter.get("/:id", (c) => {
  const task = getTask(c.req.param("id"));
  if (!task) return c.json({ error: "not_found" }, 404);
  return c.json({
    task,
    messages: listMessages(task.id),
    tool_calls: listToolCalls(task.id),
  });
});

tasksRouter.post("/", async (c) => {
  const parsed = CreateTask.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
  }
  const body = parsed.data;

  let workspace = body.workspace;
  let cleanup: (() => void) | null = null;
  let repoMeta: { owner: string; repo: string; base: string } | null = null;

  if (body.repo) {
    const [owner, repo] = body.repo.split("/");
    const cloned = await cloneRepo({ owner: owner!, repo: repo!, base: body.base });
    workspace = cloned.dir;
    cleanup = cloned.cleanup;
    repoMeta = { owner: cloned.owner, repo: cloned.repo, base: cloned.base };
  }

  // Optional RAG context
  let ragContext: string | undefined;
  if (body.rag_repo) {
    try {
      const chunks = await retrieve({ repoId: body.rag_repo, query: body.prompt, k: 8 });
      ragContext = formatForPrompt(chunks);
    } catch (e) {
      log.warn({ err: (e as Error).message }, "rag retrieve failed; continuing without");
    }
  }

  // Run the agent in the background so the POST returns immediately.
  // The runner publishes events to eventBus internally; we only use
  // onEvent here to capture the task ID synchronously.
  let resolveTaskId!: (id: string) => void;
  const taskIdReady = new Promise<string>((r) => { resolveTaskId = r; });

  const runP = runAgent({
    prompt: body.prompt,
    workspace: workspace!,
    source: body.repo ? "api/github" : "api",
    source_ref: body.repo,
    ragContext,
    onEvent: (e: AgentEvent) => {
      if (e.type === "task_created") resolveTaskId(e.task.id);
    },
  });
  const taskId = await taskIdReady;

  // Background continuation: when agent finishes, optionally open a PR + cleanup.
  void runP
    .then(async (res) => {
      if (repoMeta && cleanup) {
        try {
          const pr = await commitAndOpenPr({
            repoDir: workspace!,
            owner: repoMeta.owner,
            repo: repoMeta.repo,
            base: repoMeta.base,
            branch: `ateli/${res.task.id}`,
            title: truncate(body.prompt, 70),
            body:
              `Opened by ateli (task \`${res.task.id}\`).\n\n` +
              `Prompt:\n> ${body.prompt}\n\nFinal summary:\n${res.finalText || "(no summary)"}\n`,
          });
          if (pr) {
            eventBus.publish(res.task.id, {
              type: "assistant_text",
              turn: -1,
              text: `\n[ateli] opened PR ${pr.url}\n`,
            });
          } else {
            eventBus.publish(res.task.id, {
              type: "assistant_text",
              turn: -1,
              text: `\n[ateli] no changes to commit; PR not opened\n`,
            });
          }
        } catch (err) {
          log.error({ err: (err as Error).message }, "PR creation failed");
          eventBus.publish(res.task.id, {
            type: "assistant_text",
            turn: -1,
            text: `\n[ateli] PR creation failed: ${(err as Error).message}\n`,
          });
        }
      }
    })
    .catch((err) => log.error({ err: (err as Error).message }, "agent run failed"))
    .finally(() => {
      if (cleanup) cleanup();
    });

  const task = getTask(taskId)!;
  return c.json({ task }, 202);
});

tasksRouter.get("/:id/events", (c) => {
  const id = c.req.param("id");
  return streamSSE(c, async (stream) => {
    // Replay tool calls + messages so a late subscriber sees history.
    const msgs = listMessages(id);
    for (const m of msgs) {
      await stream.writeSSE({
        data: JSON.stringify({ type: "history_message", role: m.role, content: m.content }),
      });
    }
    let closed = false;
    const off = eventBus.subscribe(id, (ev) => {
      if (closed) return;
      stream.writeSSE({ data: JSON.stringify(ev) }).catch(() => {});
      if (ev.type === "task_finished") {
        closed = true;
        off();
      }
    });

    // Keep stream open. If the task is already done, close after replay.
    const task = getTask(id);
    if (task && (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled")) {
      closed = true;
      off();
      return;
    }
    // Heartbeat every 15s so proxies don't close the connection.
    while (!closed) {
      await new Promise((r) => setTimeout(r, 15_000));
      if (closed) break;
      try {
        await stream.writeSSE({ event: "ping", data: String(Date.now()) });
      } catch {
        closed = true;
        off();
      }
    }
  });
});

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= n ? oneLine : oneLine.slice(0, n - 1) + "…";
}
