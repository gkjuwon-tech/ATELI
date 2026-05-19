import { nanoid } from "nanoid";
import { hostname } from "node:os";
import { getDb } from "./db.js";

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface Job {
  id: string;
  created_at: number;
  updated_at: number;
  kind: string;
  payload: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_after: number;
  claimed_by: string | null;
  claimed_at: number | null;
  task_id: string | null;
  error: string | null;
}

const HEARTBEAT_STALE_MS = 60_000;

export function enqueue(args: {
  kind: string;
  payload: unknown;
  run_after?: number;
  max_attempts?: number;
}): Job {
  const id = `job_${nanoid(16)}`;
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO jobs (id, created_at, updated_at, kind, payload, status, run_after, max_attempts)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
    )
    .run(
      id,
      now,
      now,
      args.kind,
      JSON.stringify(args.payload),
      args.run_after ?? now,
      args.max_attempts ?? 3,
    );
  return getJob(id)!;
}

export function getJob(id: string): Job | null {
  return (
    (getDb().prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as
      | Job
      | undefined) ?? null
  );
}

export function listJobs(limit = 50): Job[] {
  return getDb()
    .prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as Job[];
}

/**
 * Atomically claim the next runnable job for a worker. Returns null if
 * the queue is empty. Uses SQLite's `RETURNING` so we don't race other
 * workers — only one claim succeeds per row.
 *
 * Also sweeps jobs whose worker has stopped heart-beating.
 */
export function claimNextJob(workerId: string): Job | null {
  const db = getDb();
  const now = Date.now();

  // Reclaim dead workers' jobs in the same transaction so we don't have
  // a stuck-job window when a worker crashes.
  db.prepare(
    `UPDATE jobs SET status = 'queued', claimed_by = NULL, claimed_at = NULL,
                     attempts = attempts + 0
     WHERE status = 'running'
       AND claimed_by NOT IN (
         SELECT id FROM workers WHERE heartbeat_at > ?
       )`,
  ).run(now - HEARTBEAT_STALE_MS);

  const row = db
    .prepare(
      `UPDATE jobs
       SET status = 'running',
           claimed_by = ?,
           claimed_at = ?,
           attempts = attempts + 1,
           updated_at = ?
       WHERE id = (
         SELECT id FROM jobs
         WHERE status = 'queued' AND run_after <= ?
         ORDER BY run_after ASC, created_at ASC
         LIMIT 1
       )
       RETURNING *`,
    )
    .get(workerId, now, now, now) as Job | undefined;
  return row ?? null;
}

export function finishJob(id: string, taskId?: string) {
  getDb()
    .prepare(
      `UPDATE jobs SET status = 'succeeded', updated_at = ?, task_id = COALESCE(?, task_id) WHERE id = ?`,
    )
    .run(Date.now(), taskId ?? null, id);
}

export function failJob(id: string, error: string) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as
    | Job
    | undefined;
  if (!row) return;
  const status: JobStatus = row.attempts >= row.max_attempts ? "failed" : "queued";
  db.prepare(
    `UPDATE jobs
     SET status = ?, error = ?, updated_at = ?, claimed_by = NULL, claimed_at = NULL,
         run_after = ?
     WHERE id = ?`,
  ).run(
    status,
    error,
    Date.now(),
    Date.now() + 5_000 * Math.pow(2, row.attempts),
    id,
  );
}

export function setJobTaskId(id: string, taskId: string) {
  getDb()
    .prepare(`UPDATE jobs SET task_id = ?, updated_at = ? WHERE id = ?`)
    .run(taskId, Date.now(), id);
}

// ---- worker registration ----

export interface Worker {
  id: string;
  started_at: number;
  heartbeat_at: number;
  pid: number;
  host: string;
}

export function registerWorker(): Worker {
  const id = `wrk_${nanoid(12)}`;
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO workers (id, started_at, heartbeat_at, pid, host) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, now, now, process.pid, hostname());
  return { id, started_at: now, heartbeat_at: now, pid: process.pid, host: hostname() };
}

export function heartbeatWorker(id: string) {
  getDb()
    .prepare(`UPDATE workers SET heartbeat_at = ? WHERE id = ?`)
    .run(Date.now(), id);
}

export function unregisterWorker(id: string) {
  getDb().prepare(`DELETE FROM workers WHERE id = ?`).run(id);
}
