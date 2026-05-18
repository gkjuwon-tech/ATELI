import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, requireGithubConfig } from "../../config.js";

export interface ClonedRepo {
  dir: string;
  owner: string;
  repo: string;
  base: string;
  cleanup: () => void;
}

/**
 * Shallow-clones a GitHub repo into a temp dir using the configured
 * GITHUB_TOKEN. Caller is responsible for calling `cleanup()`.
 */
export async function cloneRepo(args: {
  owner: string;
  repo: string;
  base?: string;
}): Promise<ClonedRepo> {
  const cfg = loadConfig();
  requireGithubConfig(cfg);
  const base = args.base ?? "main";
  const dir = mkdtempSync(join(tmpdir(), `ateli-${args.owner}-${args.repo}-`));

  // Token-authed HTTPS URL. We pass it via -c http.extraHeader to avoid
  // it landing in the remote URL (which could leak via `git remote -v` later).
  const url = `https://github.com/${args.owner}/${args.repo}.git`;
  const authHeader = `AUTHORIZATION: bearer ${cfg.GITHUB_TOKEN}`;

  await runGit(
    [
      "-c", `http.extraHeader=${authHeader}`,
      "clone", "--depth", "50", "--branch", base, url, dir,
    ],
    process.cwd(),
  );

  // Set committer identity locally so subsequent commits work.
  await runGit(["config", "user.name", cfg.GITHUB_COMMITTER_NAME], dir);
  await runGit(["config", "user.email", cfg.GITHUB_COMMITTER_EMAIL], dir);

  return {
    dir,
    owner: args.owner,
    repo: args.repo,
    base,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

export function runGit(argv: string[], cwd: string): Promise<string> {
  return new Promise((resolveOut, rejectOut) => {
    const child = spawn("git", argv, { cwd });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (err += b.toString("utf8")));
    child.on("close", (code) => {
      if (code === 0) resolveOut(out);
      else rejectOut(new Error(`git ${argv.slice(0, 3).join(" ")}... failed (${code}): ${err.trim()}`));
    });
    child.on("error", (e) => rejectOut(e));
  });
}
