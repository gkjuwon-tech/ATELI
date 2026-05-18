import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep, extname } from "node:path";
import ignoreMod from "ignore";
import { getDb } from "../storage/db.js";
import { childLogger } from "../logger.js";
import { embed } from "./embed.js";
import { deleteVectorsForFile, upsertVector } from "./vector.js";

type IgnoreFactory = (...args: never[]) => {
  add: (patterns: string | string[]) => void;
  ignores: (path: string) => boolean;
};
const ignore = (((ignoreMod as unknown as { default?: IgnoreFactory })
  .default ?? (ignoreMod as unknown)) as IgnoreFactory);

const log = childLogger({ component: "rag/indexer" });

const TEXT_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cs",
  ".php", ".scala", ".clj", ".ex", ".exs", ".erl",
  ".sh", ".bash", ".zsh", ".fish",
  ".sql", ".graphql", ".proto",
  ".json", ".yaml", ".yml", ".toml", ".xml",
  ".md", ".mdx", ".rst", ".txt",
  ".html", ".css", ".scss", ".vue", ".svelte",
  ".dockerfile",
]);

const MAX_FILE_BYTES = 1_000_000; // 1 MB per file
const CHUNK_LINES = 60;
const CHUNK_OVERLAP = 10;

export interface IndexStats {
  scanned: number;
  unchanged: number;
  reindexed: number;
  chunks: number;
  embedded_tokens: number;
}

export async function indexRepo(opts: {
  repoRoot: string;
  repoId: string;
}): Promise<IndexStats> {
  const root = opts.repoRoot;
  if (!existsSync(root)) {
    throw new Error(`repo root not found: ${root}`);
  }
  const ig = ignore();
  const gi = join(root, ".gitignore");
  if (existsSync(gi)) ig.add(readFileSync(gi, "utf8"));
  ig.add([
    "node_modules", ".git", "dist", "build", ".ateli",
    "*.sqlite*", "*.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "*.min.js", "*.min.css", "*.map",
  ]);

  const files: string[] = [];
  walk(root, root, ig, (rel, _abs, size) => {
    if (size > MAX_FILE_BYTES) return;
    const ext = extname(rel).toLowerCase();
    const base = rel.split("/").pop()!.toLowerCase();
    if (TEXT_EXTS.has(ext) || base === "dockerfile" || base === "makefile") {
      files.push(rel);
    }
  });

  log.info({ repo: opts.repoId, files: files.length }, "scanning");

  const db = getDb();
  const stats: IndexStats = {
    scanned: files.length,
    unchanged: 0,
    reindexed: 0,
    chunks: 0,
    embedded_tokens: 0,
  };

  const allChunks: { fileId: number; chunkRowId: number; text: string }[] = [];

  for (const rel of files) {
    const abs = join(root, rel);
    let content: string;
    try {
      const buf = readFileSync(abs);
      // skip binary
      if (buf.subarray(0, 8192).includes(0)) continue;
      content = buf.toString("utf8");
    } catch (e) {
      log.warn({ rel, err: (e as Error).message }, "read failed");
      continue;
    }
    const hash = sha256(content);

    const existing = db
      .prepare(
        `SELECT id, content_hash FROM rag_files WHERE repo = ? AND path = ?`,
      )
      .get(opts.repoId, rel) as { id: number; content_hash: string } | undefined;

    if (existing && existing.content_hash === hash) {
      stats.unchanged++;
      continue;
    }

    let fileId: number;
    if (existing) {
      fileId = existing.id;
      // wipe old chunks + vectors for re-index
      deleteVectorsForFile(fileId);
      db.prepare(`DELETE FROM rag_chunks WHERE file_id = ?`).run(fileId);
      db.prepare(
        `UPDATE rag_files SET content_hash = ?, indexed_at = ? WHERE id = ?`,
      ).run(hash, Date.now(), fileId);
    } else {
      const r = db
        .prepare(
          `INSERT INTO rag_files (repo, path, content_hash, indexed_at) VALUES (?, ?, ?, ?)`,
        )
        .run(opts.repoId, rel, hash, Date.now());
      fileId = Number(r.lastInsertRowid);
    }
    stats.reindexed++;

    const chunks = chunkText(content);
    const insertChunk = db.prepare(
      `INSERT INTO rag_chunks (file_id, chunk_index, start_line, end_line, text)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      const r = insertChunk.run(fileId, i, c.startLine, c.endLine, c.text);
      const chunkRowId = Number(r.lastInsertRowid);
      // prepend path context to help retrieval
      allChunks.push({
        fileId,
        chunkRowId,
        text: `// file: ${rel} (lines ${c.startLine}-${c.endLine})\n${c.text}`,
      });
      stats.chunks++;
    }
  }

  // embed in batches
  if (allChunks.length > 0) {
    log.info({ chunks: allChunks.length }, "embedding chunks");
    const embedResult = await embed(
      allChunks.map((c) => c.text),
      "document",
    );
    stats.embedded_tokens = embedResult.total_tokens;
    for (let i = 0; i < allChunks.length; i++) {
      upsertVector(allChunks[i]!.chunkRowId, embedResult.vectors[i]!);
    }
  }

  log.info({ repo: opts.repoId, ...stats }, "index complete");
  return stats;
}

function chunkText(content: string): {
  startLine: number;
  endLine: number;
  text: string;
}[] {
  const lines = content.split("\n");
  if (lines.length <= CHUNK_LINES) {
    return [{ startLine: 1, endLine: lines.length, text: content }];
  }
  const out: { startLine: number; endLine: number; text: string }[] = [];
  const step = CHUNK_LINES - CHUNK_OVERLAP;
  for (let i = 0; i < lines.length; i += step) {
    const end = Math.min(i + CHUNK_LINES, lines.length);
    out.push({
      startLine: i + 1,
      endLine: end,
      text: lines.slice(i, end).join("\n"),
    });
    if (end === lines.length) break;
  }
  return out;
}

function walk(
  dir: string,
  root: string,
  ig: ReturnType<IgnoreFactory>,
  visit: (rel: string, abs: string, size: number) => void,
) {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const abs = join(dir, name);
    const rel = relative(root, abs).split(sep).join("/");
    if (!rel) continue;
    let s;
    try {
      s = statSync(abs);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      if (ig.ignores(rel) || ig.ignores(rel + "/")) continue;
      walk(abs, root, ig, visit);
    } else if (s.isFile()) {
      if (ig.ignores(rel)) continue;
      visit(rel, abs, s.size);
    }
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
