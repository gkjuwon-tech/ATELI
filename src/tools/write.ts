import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { Workspace } from "../workspace/workspace.js";

export const writeInput = z.object({
  path: z.string(),
  content: z.string(),
  create_dirs: z.boolean().default(true),
});

export type WriteInput = z.infer<typeof writeInput>;

export function write(ws: Workspace, raw: unknown): string {
  const args = writeInput.parse(raw);
  const abs = ws.resolve(args.path);
  const existed = existsSync(abs);
  if (args.create_dirs) {
    mkdirSync(dirname(abs), { recursive: true });
  }
  writeFileSync(abs, args.content, "utf8");
  return `${existed ? "Updated" : "Created"} ${ws.display(abs)} (${args.content.length} bytes)`;
}
