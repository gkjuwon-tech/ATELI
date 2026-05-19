import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

let cached: Database.Database | null = null;

export function getDb(): Database.Database {
  if (cached) return cached;
  const dir = resolve(process.cwd(), process.env.ATELI_DATA_DIR ?? ".ateli");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "ateli.sqlite");
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  cached = db;
  return db;
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      source_ref TEXT,
      user_id TEXT,
      summary TEXT,
      last_task_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_source_ref ON sessions(source, source_ref);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      workspace TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      model TEXT NOT NULL,
      finish_reason TEXT,
      error TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'cli',
      source_ref TEXT,
      session_id TEXT REFERENCES sessions(id),
      user_id TEXT,
      cost_usd REAL NOT NULL DEFAULT 0,
      plan_json TEXT,
      interject_pending TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, id);

    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      turn INTEGER NOT NULL,
      tool_use_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input TEXT NOT NULL,
      output TEXT,
      is_error INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_tool_calls_task ON tool_calls(task_id, id);

    CREATE TABLE IF NOT EXISTS rag_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      indexed_at INTEGER NOT NULL,
      UNIQUE(repo, path)
    );

    CREATE TABLE IF NOT EXISTS rag_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES rag_files(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      text TEXT NOT NULL,
      symbol TEXT,
      kind TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_rag_chunks_file ON rag_chunks(file_id);

    -- Phase 2: api tokens (bearer auth)
    CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL DEFAULT 'write',
      revoked_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(hash);

    -- Phase 2: durable background job queue
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      run_after INTEGER NOT NULL,
      claimed_by TEXT,
      claimed_at INTEGER,
      task_id TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(status, run_after);
    CREATE INDEX IF NOT EXISTS idx_jobs_task ON jobs(task_id);

    -- Phase 2: worker heartbeats so dead workers get reclaimed
    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL,
      pid INTEGER NOT NULL,
      host TEXT NOT NULL
    );

    -- Phase 2: per-user style + prefs
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      prefs TEXT NOT NULL DEFAULT '{}',
      learned_style TEXT NOT NULL DEFAULT '{}'
    );
  `);
}
