import { getDb } from "../storage/db.js";
import { embed } from "./embed.js";
import { searchVectors } from "./vector.js";

export interface Retrieved {
  path: string;
  start_line: number;
  end_line: number;
  text: string;
  distance: number;
}

export async function retrieve(opts: {
  repoId: string;
  query: string;
  k?: number;
}): Promise<Retrieved[]> {
  const k = opts.k ?? 8;
  const q = await embed([opts.query], "query");
  const qv = q.vectors[0];
  if (!qv) return [];

  // Over-fetch then filter to repo, since vec0 doesn't index repo metadata.
  const candidates = searchVectors(qv, k * 5);
  if (candidates.length === 0) return [];

  const db = getDb();
  const ids = candidates.map((c) => c.chunk_id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT rc.id AS chunk_id, rc.start_line, rc.end_line, rc.text,
              rf.path, rf.repo
       FROM rag_chunks rc
       JOIN rag_files rf ON rf.id = rc.file_id
       WHERE rc.id IN (${placeholders})
         AND rf.repo = ?`,
    )
    .all(...ids, opts.repoId) as {
    chunk_id: number;
    start_line: number;
    end_line: number;
    text: string;
    path: string;
  }[];

  const distById = new Map(candidates.map((c) => [c.chunk_id, c.distance]));
  const merged = rows
    .map((r) => ({
      path: r.path,
      start_line: r.start_line,
      end_line: r.end_line,
      text: r.text,
      distance: distById.get(r.chunk_id) ?? Infinity,
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, k);

  return merged;
}

/** Format retrieved chunks into a string suitable for inlining in a prompt. */
export function formatForPrompt(chunks: Retrieved[]): string {
  if (chunks.length === 0) return "";
  return chunks
    .map(
      (c, i) =>
        `[${i + 1}] ${c.path}:${c.start_line}-${c.end_line} (dist=${c.distance.toFixed(3)})\n${c.text}`,
    )
    .join("\n\n---\n\n");
}
