import { z } from "zod";
import { childLogger } from "./logger.js";
import {
  claimNextJob,
  failJob,
  finishJob,
  heartbeatWorker,
  registerWorker,
  setJobTaskId,
  unregisterWorker,
} from "./storage/jobs.js";
import { runAgent } from "./agent/runner.js";
import { cloneRepo } from "./surfaces/github/clone.js";
import { commitAndOpenPr } from "./surfaces/github/pr.js";
import { retrieve, formatForPrompt } from "./rag/retriever.js";

const log = childLogger({ component: "worker" });

/** Payload schema for the only job kind we currently process. */
const RunTaskPayload = z.object({
  prompt: z.string().min(1),
  workspace: z.string().optional(),
  repo: z.string().regex(/^[^/]+\/[^/]+$/).optional(),
  base: z.string().optional(),
  rag_repo: z.string().optional(),
  session_id: z.string().optional(),
  user_id: z.string().optional(),
  source: z.string().optional(),
  source_ref: z.string().optional(),
  plan_mode: z.boolean().optional(),
  critique: z.boolean().optional(),
  budget_usd: z.number().positive().optional(),
});

export type RunTaskPayload = z.infer<typeof RunTaskPayload>;

export interface WorkerHandle {
  stop: () => Promise<void>;
}

/**
 * Long-running worker loop. Claims jobs one at a time, processes them,
 * and heartbeats so other workers can reclaim if this one dies.
 */
export function startWorker(opts: { concurrency?: number } = {}): WorkerHandle {
  const concurrency = Math.max(1, Math.min(8, opts.concurrency ?? 1));
  const worker = registerWorker();
  log.info({ worker_id: worker.id, concurrency }, "worker started");

  let stopping = false;
  const heartbeat = setInterval(() => heartbeatWorker(worker.id), 10_000);

  const slots: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    slots.push(loop(worker.id, () => stopping));
  }

  return {
    async stop() {
      stopping = true;
      clearInterval(heartbeat);
      await Promise.all(slots);
      unregisterWorker(worker.id);
      log.info({ worker_id: worker.id }, "worker stopped");
    },
  };
}

async function loop(workerId: string, isStopping: () => boolean) {
  while (!isStopping()) {
    const job = claimNextJob(workerId);
    if (!job) {
      await sleep(1000);
      continue;
    }
    log.info({ job_id: job.id, kind: job.kind, attempts: job.attempts }, "job claimed");
    try {
      const taskId = await processJob(job);
      finishJob(job.id, taskId);
      log.info({ job_id: job.id, task_id: taskId }, "job succeeded");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ job_id: job.id, err: msg }, "job failed");
      failJob(job.id, msg);
    }
  }
}

async function processJob(job: {
  id: string;
  kind: string;
  payload: string;
}): Promise<string | undefined> {
  if (job.kind !== "run_task") {
    throw new Error(`unknown job kind: ${job.kind}`);
  }
  const payload = RunTaskPayload.parse(JSON.parse(job.payload));

  let workspace = payload.workspace;
  let cleanup: (() => void) | null = null;
  let repoMeta: { owner: string; repo: string; base: string } | null = null;

  if (payload.repo) {
    const [owner, repo] = payload.repo.split("/");
    const cloned = await cloneRepo({ owner: owner!, repo: repo!, base: payload.base });
    workspace = cloned.dir;
    cleanup = cloned.cleanup;
    repoMeta = { owner: cloned.owner, repo: cloned.repo, base: cloned.base };
  }
  if (!workspace) throw new Error("either workspace or repo is required");

  let ragContext: string | undefined;
  if (payload.rag_repo) {
    try {
      const chunks = await retrieve({
        repoId: payload.rag_repo,
        query: payload.prompt,
        k: 8,
      });
      ragContext = formatForPrompt(chunks);
    } catch (e) {
      log.warn({ err: (e as Error).message }, "rag retrieve failed; skipping");
    }
  }

  let taskId: string | undefined;
  try {
    const result = await runAgent({
      prompt: payload.prompt,
      workspace,
      source: payload.source ?? (payload.repo ? "worker/github" : "worker"),
      source_ref: payload.source_ref ?? payload.repo,
      user_id: payload.user_id,
      session_id: payload.session_id,
      plan_mode: payload.plan_mode,
      critique: payload.critique,
      budget_usd: payload.budget_usd,
      ragContext,
      onEvent: (e) => {
        if (e.type === "task_created") {
          taskId = e.task.id;
          setJobTaskId(job.id, e.task.id);
        }
      },
    });

    if (repoMeta) {
      const pr = await commitAndOpenPr({
        repoDir: workspace,
        owner: repoMeta.owner,
        repo: repoMeta.repo,
        base: repoMeta.base,
        branch: `ateli/${result.task.id}`,
        title: truncate(payload.prompt, 70),
        body:
          `Opened by ateli worker (task \`${result.task.id}\`).\n\n` +
          `Prompt:\n> ${payload.prompt}\n\nFinal summary:\n${result.finalText || "(no summary)"}\n`,
      });
      log.info(
        { task_id: result.task.id, pr: pr?.url ?? "no-op" },
        "PR step complete",
      );
    }
    return taskId ?? result.task.id;
  } finally {
    if (cleanup) cleanup();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : one.slice(0, n - 1) + "…";
}
