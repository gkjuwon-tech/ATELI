import { Octokit } from "@octokit/rest";
import { loadConfig, requireGithubConfig } from "../../config.js";
import { runGit } from "./clone.js";

let cachedClient: Octokit | null = null;
function client(): Octokit {
  if (cachedClient) return cachedClient;
  const cfg = loadConfig();
  requireGithubConfig(cfg);
  cachedClient = new Octokit({ auth: cfg.GITHUB_TOKEN });
  return cachedClient;
}

export interface PrResult {
  number: number;
  url: string;
  head: string;
}

/**
 * After the agent has modified files in `repoDir`, stage everything,
 * commit on a new feature branch, push, and open a PR against `base`.
 *
 * Returns null if there are no changes to commit.
 */
export async function commitAndOpenPr(args: {
  repoDir: string;
  owner: string;
  repo: string;
  base: string;
  branch: string;
  title: string;
  body: string;
}): Promise<PrResult | null> {
  const cfg = loadConfig();
  requireGithubConfig(cfg);

  // Anything to commit?
  const status = await runGit(["status", "--porcelain"], args.repoDir);
  if (status.trim() === "") return null;

  await runGit(["checkout", "-b", args.branch], args.repoDir);
  await runGit(["add", "-A"], args.repoDir);
  await runGit(["commit", "-m", args.title], args.repoDir);

  const authHeader = `AUTHORIZATION: bearer ${cfg.GITHUB_TOKEN}`;
  await runGit(
    [
      "-c", `http.extraHeader=${authHeader}`,
      "push", "-u", "origin", args.branch,
    ],
    args.repoDir,
  );

  const pr = await client().pulls.create({
    owner: args.owner,
    repo: args.repo,
    base: args.base,
    head: args.branch,
    title: args.title,
    body: args.body,
    draft: true,
  });

  return {
    number: pr.data.number,
    url: pr.data.html_url,
    head: args.branch,
  };
}
