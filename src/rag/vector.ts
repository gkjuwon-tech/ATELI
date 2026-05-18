import * as sqliteVec from "sqlite-vec";
import { getDb } from "../storage/db.js";
import { expectedDim } from "./embed.js";
import { loadConfig } from "../config.js";

let initialized = false;

/**
 * Loads the sqlite-vec extension and ensures the vec0 virtual table exists.
 * Dimension is locked at table creation, so changing models requires
 * dropping the table.
 */
export function initVector() {
  if (initialized) return;
  const db = getDb();
  sqliteVec.load(db);
  const dim = expectedDim(loadConfig().VOYAGE_EMBED_MODEL);
  // vec0 tables key rows by rowid implicitly; don't declare a separate PK.
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS rag_vec USING vec0(
       embedding FLOAT[${dim}]
     )`,
  );
  initialized = true;
}

export function upsertVector(chunkId: number, vec: number[]) {
  initVector();
  const db = getDb();
  // vec0 expects the embedding as a Buffer of float32 LE, and the rowid
  // must bind as INTEGER (better-sqlite3's safest path is BigInt).
  const buf = floatArrayToBuffer(vec);
  const rid = BigInt(chunkId);
  db.prepare(`DELETE FROM rag_vec WHERE rowid = ?`).run(rid);
  db.prepare(`INSERT INTO rag_vec (rowid, embedding) VALUES (?, ?)`).run(
    rid,
    buf,
  );
}

export interface VectorMatch {
  chunk_id: number;
  distance: number;
}

export function searchVectors(query: number[], k: number): VectorMatch[] {
  initVector();
  const db = getDb();
  const buf = floatArrayToBuffer(query);
  return db
    .prepare(
      `SELECT rowid AS chunk_id, distance
       FROM rag_vec
       WHERE embedding MATCH ?
         AND k = ?
       ORDER BY distance ASC`,
    )
    .all(buf, k) as VectorMatch[];
}

export function deleteVectorsForFile(fileId: number) {
  const db = getDb();
  db.prepare(
    `DELETE FROM rag_vec
     WHERE rowid IN (SELECT id FROM rag_chunks WHERE file_id = ?)`,
  ).run(fileId);
}

function floatArrayToBuffer(arr: number[]): Buffer {
  const buf = Buffer.alloc(arr.length * 4);
  for (let i = 0; i < arr.length; i++) {
    buf.writeFloatLE(arr[i]!, i * 4);
  }
  return buf;
}
