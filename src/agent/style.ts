import { getDb } from "../storage/db.js";

export interface UserProfile {
  user_id: string;
  created_at: number;
  updated_at: number;
  prefs: Record<string, unknown>;
  learned_style: Record<string, unknown>;
}

interface RawRow {
  user_id: string;
  created_at: number;
  updated_at: number;
  prefs: string;
  learned_style: string;
}

export function getProfile(userId: string): UserProfile | null {
  const row = getDb()
    .prepare(`SELECT * FROM user_profiles WHERE user_id = ?`)
    .get(userId) as RawRow | undefined;
  if (!row) return null;
  return decode(row);
}

export function upsertProfile(args: {
  user_id: string;
  prefs?: Record<string, unknown>;
  learned_style?: Record<string, unknown>;
}): UserProfile {
  const now = Date.now();
  const existing = getProfile(args.user_id);
  if (existing) {
    const prefs = { ...existing.prefs, ...(args.prefs ?? {}) };
    const learned = { ...existing.learned_style, ...(args.learned_style ?? {}) };
    getDb()
      .prepare(
        `UPDATE user_profiles SET prefs = ?, learned_style = ?, updated_at = ? WHERE user_id = ?`,
      )
      .run(JSON.stringify(prefs), JSON.stringify(learned), now, args.user_id);
    return getProfile(args.user_id)!;
  }
  getDb()
    .prepare(
      `INSERT INTO user_profiles (user_id, created_at, updated_at, prefs, learned_style)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      args.user_id,
      now,
      now,
      JSON.stringify(args.prefs ?? {}),
      JSON.stringify(args.learned_style ?? {}),
    );
  return getProfile(args.user_id)!;
}

/** Render a short paragraph to inject into the system prompt. */
export function profileForPrompt(p: UserProfile | null): string {
  if (!p) return "";
  const lines: string[] = [];
  if (Object.keys(p.prefs).length > 0) {
    lines.push("Explicit preferences:");
    for (const [k, v] of Object.entries(p.prefs)) lines.push(`  - ${k}: ${stringify(v)}`);
  }
  if (Object.keys(p.learned_style).length > 0) {
    lines.push("Observed style:");
    for (const [k, v] of Object.entries(p.learned_style))
      lines.push(`  - ${k}: ${stringify(v)}`);
  }
  if (lines.length === 0) return "";
  return `User style (apply unless the existing repo conventions disagree):\n${lines.join("\n")}`;
}

function decode(row: RawRow): UserProfile {
  return {
    user_id: row.user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    prefs: safeJson(row.prefs),
    learned_style: safeJson(row.learned_style),
  };
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}
