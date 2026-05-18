import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { z } from "zod";
import type { Workspace } from "../workspace/workspace.js";

export const editInput = z.object({
  path: z.string(),
  old_string: z.string().min(1, "old_string must not be empty"),
  new_string: z.string(),
  replace_all: z.boolean().default(false),
});

export type EditInput = z.infer<typeof editInput>;

export function edit(ws: Workspace, raw: unknown): string {
  const args = editInput.parse(raw);
  const abs = ws.resolve(args.path);
  if (!existsSync(abs)) {
    throw new Error(`file not found: ${args.path}`);
  }
  const original = readFileSync(abs, "utf8");
  if (args.old_string === args.new_string) {
    throw new Error("old_string and new_string are identical");
  }
  if (args.replace_all) {
    const occurrences = countOccurrences(original, args.old_string);
    if (occurrences === 0) {
      throw new Error(`old_string not found in ${args.path}`);
    }
    const updated = original.split(args.old_string).join(args.new_string);
    writeFileSync(abs, updated, "utf8");
    return `Replaced ${occurrences} occurrence(s) in ${ws.display(abs)}`;
  }
  const first = original.indexOf(args.old_string);
  if (first === -1) {
    throw new Error(`old_string not found in ${args.path}`);
  }
  const second = original.indexOf(args.old_string, first + 1);
  if (second !== -1) {
    throw new Error(
      `old_string is not unique in ${args.path}. Provide more context or set replace_all=true.`,
    );
  }
  const updated =
    original.slice(0, first) +
    args.new_string +
    original.slice(first + args.old_string.length);
  writeFileSync(abs, updated, "utf8");
  return `Edited ${ws.display(abs)}`;
}

function countOccurrences(hay: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    count++;
    i += needle.length;
  }
  return count;
}
