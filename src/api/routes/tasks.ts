import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  getTask,
  listMessages,
  listTasks,
  listToolCalls,
  setTaskInterject,
} from "../../storage/tasks.js";
import { eventBus } from "../../events/bus.js";
import { childLogger } from "../../logger.js";
import { enqueue, getJob } from "../../storage/jobs.js";
import { auth } from "../middleware/auth.js";

const log = childLogger({ component: "api/tasks" });

const CreateTask = z
  .object({
    prompt: z.string().min(1),
    workspace: z.string().optional(),
    repo: z.string().regex(/^[^/]+\/[^/]+$/).optional(),
    base: z.string().optional(),
    rag_repo: z.string().optional(),
    session_id: z.string().optional(),
    plan_mode: z.boolean().optional(),
    critique: z.boolean().optional(),
    budget_usd: z.number().positive().optional(),
    /** synchronous mode: process in-request, return when done (legacy). */
    sync: z.boolean().optional(),
  })
  .refine((v) => !!v.workspace || !!v.repo, {
    message: "either `workspace` or `repo` is required",
  });

const Interject = z.object({
  text: z.string().min(1),
});

export const tasksRouter = new Hono();

// Read endpoints — read scope is enough.
tasksRouter.get("/", auth({ scope: "read" }), (c) => {
  const limit = Number(c.req.query("limit") ?? "50");
  return c.json({ tasks: listTasks(limit) });
});

tasksRouter.get("/:id", auth({ scope: "read" }), (c) => {
  const task = getTask(c.req.param("id"));
  if (!task) return c.json({ error: "not_found" }, 404);
  return c.json({
    task,
    messages: listMessages(task.id),
    tool_calls: listToolCalls(task.id),
  });
});

// Write endpoints — write scope.
tasksRouter.post("/", auth({ scope: "write" }), async (c) => {
  const parsed = CreateTask.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
  }
  const body = parsed.data;
  const authCtx = c.get("auth");

  // Enqueue rather than run inline. The worker process picks it up.
  const job = enqueue({
    kind: "run_task",
    payload: {
      prompt: body.prompt,
      workspace: body.workspace,
      repo: body.repo,
      base: body.base,
      rag_repo: body.rag_repo,
      session_id: body.session_id,
      plan_mode: body.plan_mode,
      critique: body.critique,
      budget_usd: body.budget_usd,
      source: "api",
      source_ref: body.repo,
      user_id: authCtx?.user_id,
    },
  });
  log.info({ job_id: job.id }, "task enqueued");
  return c.json({ job_id: job.id, status: job.status }, 202);
});

// Real-time interject: inject a user message into a running task.
tasksRouter.post("/:id/interject", auth({ scope: "write" }), async (c) => {
  const id = c.req.param("id");
  const task = getTask(id);
  if (!task) return c.json({ error: "not_found" }, 404);
  if (task.status !== "running" && task.status !== "pending") {
    return c.json({ error: "task_not_active", status: task.status }, 409);
  }
  const parsed = Interject.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400);
  setTaskInterject(id, parsed.data.text);
  return c.json({ ok: true });
});

// Job status (so a client that just POSTed knows when the task spawned).
tasksRouter.get("/jobs/:id", auth({ scope: "read" }), (c) => {
  const job = getJob(c.req.param("id"));
  if (!job) return c.json({ error: "not_found" }, 404);
  return c.json({ job });
});

// SSE event stream — anonymous OK if auth not required.
tasksRouter.get("/:id/events", auth({ scope: "read" }), (c) => {
  const id = c.req.param("id");
  return streamSSE(c, async (stream) => {
    const msgs = listMessages(id);
    for (const m of msgs) {
      await stream.writeSSE({
        data: JSON.stringify({
          type: "history_message",
          role: m.role,
          content: m.content,
        }),
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

    const task = getTask(id);
    if (
      task &&
      (task.status === "succeeded" ||
        task.status === "failed" ||
        task.status === "cancelled")
    ) {
      closed = true;
      off();
      return;
    }
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
