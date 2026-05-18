import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ignoreMod from "ignore";

// `ignore` ships as CJS; under NodeNext the default export lands on `.default`.
type IgnoreFactory = (...args: never[]) => {
  add: (patterns: string | string[]) => void;
  ignores: (path: string) => boolean;
};
const ignore = (((ignoreMod as unknown as { default?: IgnoreFactory })
  .default ?? (ignoreMod as unknown)) as IgnoreFactory);
import { z } from "zod";
import type { Workspace } from "../workspace/workspace.js";

export const globInput = z.object({
  pattern: z.string().min(1),
  path: z.string().default("."),
  max_results: z.number().int().positive().max(2000).default(500),
});

export type GlobInput = z.infer<typeof globInput>;

/**
 * Minimal glob: supports `*`, `**`, `?`, character classes `[abc]`, and
 * alternation `{a,b}`. Respects .gitignore at workspace root if present.
 */
export function glob(ws: Workspace, raw: unknown): string {
  const args = globInput.parse(raw);
  const rootAbs = ws.resolve(args.path);
  const re = compileGlob(args.pattern);

  const ig = ignore();
  const gitignore = join(ws.root, ".gitignore");
  if (existsSync(gitignore)) {
    try {
      ig.add(readFileSync(gitignore, "utf8"));
    } catch {
      // ignore
    }
  }
  // always ignore these noisy dirs
  ig.add(["node_modules", ".git", "dist", "build", ".ateli", "*.sqlite*"]);

  const matches: string[] = [];
  walk(rootAbs, ws.root, ig, (rel) => {
    if (re.test(rel)) {
      matches.push(rel);
      if (matches.length >= args.max_results) return false;
    }
    return true;
  });

  if (matches.length === 0) {
    return `No files match ${args.pattern} under ${args.path}`;
  }
  matches.sort();
  return matches.join("\n");
}

function walk(
  dir: string,
  wsRoot: string,
  ig: ReturnType<IgnoreFactory>,
  visit: (relPath: string) => boolean,
): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return true;
  }
  for (const name of entries) {
    const abs = join(dir, name);
    const rel = relative(wsRoot, abs).split(sep).join("/");
    if (!rel || ig.ignores(rel)) continue;
    let s;
    try {
      s = statSync(abs);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      // ignore.ignores requires a trailing slash for dirs
      if (ig.ignores(rel + "/")) continue;
      if (!walk(abs, wsRoot, ig, visit)) return false;
    } else if (s.isFile()) {
      if (!visit(rel)) return false;
    }
  }
  return true;
}

/** Compile a glob pattern to a RegExp matching workspace-relative paths. */
function compileGlob(pat: string): RegExp {
  let i = 0;
  let out = "^";
  while (i < pat.length) {
    const ch = pat[i]!;
    if (ch === "*") {
      if (pat[i + 1] === "*") {
        // ** -> match any chars including /
        out += ".*";
        i += 2;
        if (pat[i] === "/") i++;
      } else {
        out += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      out += "[^/]";
      i++;
    } else if (ch === "[") {
      const end = pat.indexOf("]", i + 1);
      if (end === -1) {
        out += "\\[";
        i++;
      } else {
        out += pat.slice(i, end + 1);
        i = end + 1;
      }
    } else if (ch === "{") {
      const end = pat.indexOf("}", i + 1);
      if (end === -1) {
        out += "\\{";
        i++;
      } else {
        const alts = pat
          .slice(i + 1, end)
          .split(",")
          .map(escapeRe)
          .join("|");
        out += `(${alts})`;
        i = end + 1;
      }
    } else if (/[.+^$()|\\]/.test(ch)) {
      out += "\\" + ch;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  out += "$";
  return new RegExp(out);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
