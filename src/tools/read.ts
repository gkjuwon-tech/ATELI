import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import type { Workspace } from "../workspace/workspace.js";

export const readInput = z.object({
  path: z.string(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(5000).optional(),
});

export type ReadInput = z.infer<typeof readInput>;

const DEFAULT_LIMIT = 2000;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB hard cap

export function read(ws: Workspace, raw: unknown): string {
  const args = readInput.parse(raw);
  const abs = ws.resolve(args.path);
  const s = statSync(abs);
  if (s.isDirectory()) {
    throw new Error(`path is a directory, not a file: ${args.path}`);
  }
  if (s.size > MAX_BYTES) {
    throw new Error(
      `file too large (${s.size} bytes, max ${MAX_BYTES}). Use offset/limit to read in chunks.`,
    );
  }
  const buf = readFileSync(abs);
  // Heuristic binary detection: NUL byte in first 8KB.
  const probe = buf.subarray(0, Math.min(8192, buf.length));
  if (probe.includes(0)) {
    throw new Error(`refusing to read binary file: ${args.path}`);
  }
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  const offset = args.offset ?? 0;
  const limit = args.limit ?? DEFAULT_LIMIT;
  const slice = lines.slice(offset, offset + limit);
  const numbered = slice
    .map((line, i) => `${String(offset + i + 1).padStart(6, " ")}\t${line}`)
    .join("\n");
  const more =
    offset + slice.length < lines.length
      ? `\n... (${lines.length - offset - slice.length} more lines)`
      : "";
  return numbered + more;
}
