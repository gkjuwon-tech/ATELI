import { resolve, relative, isAbsolute, sep } from "node:path";
import { realpathSync, existsSync, statSync, mkdirSync } from "node:fs";

/**
 * A Workspace pins the agent to a single root directory on disk.
 * Every path the agent touches is resolved against this root and
 * rejected if it escapes via `..`, absolute paths, or symlinks
 * that point outside.
 */
export class Workspace {
  readonly root: string;

  constructor(root: string) {
    const abs = isAbsolute(root) ? root : resolve(process.cwd(), root);
    if (!existsSync(abs)) {
      mkdirSync(abs, { recursive: true });
    }
    const s = statSync(abs);
    if (!s.isDirectory()) {
      throw new Error(`workspace root is not a directory: ${abs}`);
    }
    this.root = realpathSync(abs);
  }

  /**
   * Resolve an agent-supplied path against the workspace root.
   * Throws if the resolved path escapes the workspace.
   */
  resolve(p: string): string {
    if (!p || typeof p !== "string") {
      throw new Error("path must be a non-empty string");
    }
    // Reject absolute paths outright — agents must use workspace-relative.
    if (isAbsolute(p)) {
      throw new Error(`absolute paths are not allowed: ${p}`);
    }
    const candidate = resolve(this.root, p);
    const rel = relative(this.root, candidate);
    if (rel.startsWith("..") || rel === ".." || isAbsolute(rel)) {
      throw new Error(`path escapes workspace: ${p}`);
    }
    // If the path exists, also verify the real path stays inside
    // (defends against pre-existing symlinks pointing out).
    if (existsSync(candidate)) {
      const real = realpathSync(candidate);
      const realRel = relative(this.root, real);
      if (realRel.startsWith("..") || isAbsolute(realRel)) {
        throw new Error(`symlinked path escapes workspace: ${p}`);
      }
      return real;
    }
    return candidate;
  }

  /** Path relative to root, for display. */
  display(absPath: string): string {
    const rel = relative(this.root, absPath);
    return rel === "" ? "." : rel.split(sep).join("/");
  }
}
