import { spawn } from "node:child_process";
import { z } from "zod";
import type { Workspace } from "../workspace/workspace.js";

export const grepInput = z.object({
  pattern: z.string().min(1),
  path: z.string().default("."),
  glob: z.string().optional(),
  case_insensitive: z.boolean().default(false),
  max_results: z.number().int().positive().max(1000).default(200),
});

export type GrepInput = z.infer<typeof grepInput>;

/**
 * Searches with `grep -R` (POSIX), preferring `rg` if available.
 * Falls back to grep so the agent works on minimal images.
 */
export async function grep(ws: Workspace, raw: unknown): Promise<string> {
  const args = grepInput.parse(raw);
  const abs = ws.resolve(args.path);

  const hasRg = await commandExists("rg");
  const argv: string[] = [];
  let bin: string;
  if (hasRg) {
    bin = "rg";
    argv.push("--line-number", "--no-heading", "--color=never");
    if (args.case_insensitive) argv.push("-i");
    if (args.glob) argv.push("--glob", args.glob);
    argv.push("--max-count", String(args.max_results));
    argv.push("--", args.pattern, abs);
  } else {
    bin = "grep";
    argv.push("-RIn");
    if (args.case_insensitive) argv.push("-i");
    if (args.glob) argv.push("--include", args.glob);
    argv.push("-e", args.pattern, abs);
  }

  return await new Promise<string>((resolveOut) => {
    const child = spawn(bin, argv, { cwd: ws.root });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => {
      out += b.toString("utf8");
      if (out.length > 100_000) {
        out = out.slice(0, 100_000) + "\n... (truncated)";
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (b: Buffer) => {
      err += b.toString("utf8");
    });
    child.on("close", (code) => {
      // grep/rg exit 1 means no matches — not an error.
      if (code === 0 || code === 1) {
        const trimmed = out.trim();
        if (!trimmed) {
          resolveOut(`No matches for /${args.pattern}/ in ${args.path}`);
          return;
        }
        // Rewrite absolute workspace paths back to relative for clarity.
        const rewritten = trimmed
          .split("\n")
          .map((line) => line.replace(ws.root + "/", ""))
          .join("\n");
        resolveOut(rewritten);
      } else {
        resolveOut(`search failed (exit ${code}): ${err.trim()}`);
      }
    });
  });
}

function commandExists(cmd: string): Promise<boolean> {
  return new Promise((res) => {
    const c = spawn("bash", ["-lc", `command -v ${cmd}`]);
    c.on("close", (code) => res(code === 0));
    c.on("error", () => res(false));
  });
}
