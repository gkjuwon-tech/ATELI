import { nanoid } from "nanoid";
import { getDb } from "./db.js";
import type { MessageRow } from "./tasks.js";

export interface Session {
  id: string;
  created_at: number;
  updated_at: number;
  source: string;
  source_ref: string | null;
  user_id: string | null;
  summary: string | null;
  last_task_id: string | null;
}

export function createSession(args: {
  source: string;
  source_ref?: string;
  user_id?: string;
}): Session {
  const id = `sess_${nanoid(16)}`;
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO sessions (id, created_at, updated_at, source, source_ref, user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, now, now, args.source, args.source_ref ?? null, args.user_id ?? null);
  return getSession(id)!;
}

export function getSession(id: string): Session | null {
  const row = getDb().prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
    | Session
    | undefined;
  return row ?? null;
}

/**
 * Find or create a session by (source, source_ref). Slack uses
 * `channel:thread_ts`; HTTP uses an explicit session_id (so this lookup
 * only matters for Slack and the CLI's --session-tag affordance).
 */
export function findOrCreateSessionByRef(args: {
  source: string;
  source_ref: string;
  user_id?: string;
}): Session {
  const existing = getDb()
    .prepare(`SELECT * FROM sessions WHERE source = ? AND source_ref = ?`)
    .get(args.source, args.source_ref) as Session | undefined;
  if (existing) return existing;
  return createSession(args);
}

export function touchSession(id: string, lastTaskId: string) {
  getDb()
    .prepare(
      `UPDATE sessions SET updated_at = ?, last_task_id = ? WHERE id = ?`,
    )
    .run(Date.now(), lastTaskId, id);
}

export function setSessionSummary(id: string, summary: string) {
  getDb()
    .prepare(`UPDATE sessions SET summary = ?, updated_at = ? WHERE id = ?`)
    .run(summary, Date.now(), id);
}

/**
 * Pull every prior task's message log in the same session, oldest first,
 * so a new run can prepend the conversation history.
 */
export function listSessionMessages(
  sessionId: string,
  excludeTaskId?: string,
): MessageRow[] {
  const params: unknown[] = [sessionId];
  let sql = `SELECT m.* FROM messages m
             JOIN tasks t ON t.id = m.task_id
             WHERE t.session_id = ?`;
  if (excludeTaskId) {
    sql += ` AND m.task_id <> ?`;
    params.push(excludeTaskId);
  }
  sql += ` ORDER BY t.created_at ASC, m.id ASC`;
  return getDb().prepare(sql).all(...params) as MessageRow[];
}

export function listSessions(limit = 50): Session[] {
  return getDb()
    .prepare(`SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?`)
    .all(limit) as Session[];
}
