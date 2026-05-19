import { createHash, randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { getDb } from "./db.js";

export type Scope = "read" | "write" | "admin";

export interface ApiToken {
  id: string;
  created_at: number;
  last_used_at: number | null;
  user_id: string;
  name: string;
  hash: string;
  scope: Scope;
  revoked_at: number | null;
}

const SCOPE_LEVEL: Record<Scope, number> = { read: 1, write: 2, admin: 3 };

function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Generate, hash, and persist a new bearer token. Returns the plaintext
 * exactly once — the caller is responsible for showing it to the user
 * because we never store it.
 */
export function issueToken(args: {
  user_id: string;
  name: string;
  scope: Scope;
}): { id: string; plaintext: string } {
  const id = `tok_${nanoid(12)}`;
  // 32 random bytes = 64 hex chars = 256 bits of entropy.
  const secret = randomBytes(32).toString("hex");
  const plaintext = `atk_${id.slice(4)}_${secret}`;
  const hash = hashToken(plaintext);
  getDb()
    .prepare(
      `INSERT INTO api_tokens (id, created_at, user_id, name, hash, scope)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, Date.now(), args.user_id, args.name, hash, args.scope);
  return { id, plaintext };
}

export interface ResolvedToken {
  id: string;
  user_id: string;
  scope: Scope;
}

/**
 * Validate a plaintext bearer token. Returns the resolved record if it
 * matches and is not revoked, otherwise null. Updates last_used_at on hit.
 */
export function resolveToken(plaintext: string): ResolvedToken | null {
  if (!plaintext || !plaintext.startsWith("atk_")) return null;
  const hash = hashToken(plaintext);
  const row = getDb()
    .prepare(`SELECT * FROM api_tokens WHERE hash = ? AND revoked_at IS NULL`)
    .get(hash) as ApiToken | undefined;
  if (!row) return null;
  getDb()
    .prepare(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`)
    .run(Date.now(), row.id);
  return { id: row.id, user_id: row.user_id, scope: row.scope };
}

export function revokeToken(id: string) {
  getDb()
    .prepare(`UPDATE api_tokens SET revoked_at = ? WHERE id = ?`)
    .run(Date.now(), id);
}

export function listTokens(userId?: string): ApiToken[] {
  if (userId) {
    return getDb()
      .prepare(
        `SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`,
      )
      .all(userId) as ApiToken[];
  }
  return getDb()
    .prepare(`SELECT * FROM api_tokens ORDER BY created_at DESC`)
    .all() as ApiToken[];
}

export function hasScope(have: Scope, required: Scope): boolean {
  return SCOPE_LEVEL[have] >= SCOPE_LEVEL[required];
}
