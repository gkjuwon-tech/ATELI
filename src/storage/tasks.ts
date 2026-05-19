import { nanoid } from "nanoid";
import { getDb } from "./db.js";

export type TaskStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface Task {
  id: string;
  created_at: number;
  updated_at: number;
  workspace: string;
  prompt: string;
  status: TaskStatus;
  model: string;
  finish_reason: string | null;
  error: string | null;
  input_tokens: number;
  output_tokens: number;
  source: string;
  source_ref: string | null;
  session_id: string | null;
  user_id: string | null;
  cost_usd: number;
  plan_json: string | null;
  interject_pending: string | null;
}

export interface ToolCallRow {
  id: number;
  task_id: string;
  created_at: number;
  turn: number;
  tool_use_id: string;
  tool_name: string;
  input: string;
  output: string | null;
  is_error: number;
  duration_ms: number | null;
}

export interface MessageRow {
  id: number;
  task_id: string;
  created_at: number;
  role: string;
  content: string;
}

export function createTask(args: {
  workspace: string;
  prompt: string;
  model: string;
  source?: string;
  source_ref?: string;
  session_id?: string;
  user_id?: string;
}): Task {
  const now = Date.now();
  const id = `tsk_${nanoid(16)}`;
  const db = getDb();
  db.prepare(
    `INSERT INTO tasks (id, created_at, updated_at, workspace, prompt, status, model, source, source_ref, session_id, user_id)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    now,
    now,
    args.workspace,
    args.prompt,
    args.model,
    args.source ?? "cli",
    args.source_ref ?? null,
    args.session_id ?? null,
    args.user_id ?? null,
  );
  return getTask(id)!;
}

export function setTaskPlan(id: string, plan: unknown) {
  getDb()
    .prepare(`UPDATE tasks SET plan_json = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(plan), Date.now(), id);
}

export function addTaskCost(id: string, deltaUsd: number) {
  getDb()
    .prepare(
      `UPDATE tasks SET cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?`,
    )
    .run(deltaUsd, Date.now(), id);
}

export function setTaskInterject(id: string, text: string | null) {
  getDb()
    .prepare(`UPDATE tasks SET interject_pending = ? WHERE id = ?`)
    .run(text, id);
}

export function takeTaskInterject(id: string): string | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT interject_pending FROM tasks WHERE id = ?`)
    .get(id) as { interject_pending: string | null } | undefined;
  if (!row?.interject_pending) return null;
  db.prepare(`UPDATE tasks SET interject_pending = NULL WHERE id = ?`).run(id);
  return row.interject_pending;
}

export function getTask(id: string): Task | null {
  const row = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
    | Task
    | undefined;
  return row ?? null;
}

export function listTasks(limit = 50): Task[] {
  return getDb()
    .prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?")
    .all(limit) as Task[];
}

export function updateTaskStatus(
  id: string,
  status: TaskStatus,
  extra?: { finish_reason?: string; error?: string },
) {
  const db = getDb();
  db.prepare(
    `UPDATE tasks
     SET status = ?, updated_at = ?, finish_reason = COALESCE(?, finish_reason), error = COALESCE(?, error)
     WHERE id = ?`,
  ).run(status, Date.now(), extra?.finish_reason ?? null, extra?.error ?? null, id);
}

export function addTaskTokens(id: string, input: number, output: number) {
  getDb()
    .prepare(
      `UPDATE tasks SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, updated_at = ? WHERE id = ?`,
    )
    .run(input, output, Date.now(), id);
}

export function appendMessage(taskId: string, role: string, content: unknown) {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  getDb()
    .prepare(
      `INSERT INTO messages (task_id, created_at, role, content) VALUES (?, ?, ?, ?)`,
    )
    .run(taskId, Date.now(), role, text);
}

export function listMessages(taskId: string): MessageRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM messages WHERE task_id = ? ORDER BY id ASC`,
    )
    .all(taskId) as MessageRow[];
}

export function recordToolCall(args: {
  task_id: string;
  turn: number;
  tool_use_id: string;
  tool_name: string;
  input: unknown;
}): number {
  const res = getDb()
    .prepare(
      `INSERT INTO tool_calls (task_id, created_at, turn, tool_use_id, tool_name, input)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.task_id,
      Date.now(),
      args.turn,
      args.tool_use_id,
      args.tool_name,
      JSON.stringify(args.input),
    );
  return Number(res.lastInsertRowid);
}

export function finishToolCall(args: {
  id: number;
  output: string;
  is_error: boolean;
  duration_ms: number;
}) {
  getDb()
    .prepare(
      `UPDATE tool_calls SET output = ?, is_error = ?, duration_ms = ? WHERE id = ?`,
    )
    .run(args.output, args.is_error ? 1 : 0, args.duration_ms, args.id);
}

export function listToolCalls(taskId: string): ToolCallRow[] {
  return getDb()
    .prepare(`SELECT * FROM tool_calls WHERE task_id = ? ORDER BY id ASC`)
    .all(taskId) as ToolCallRow[];
}
