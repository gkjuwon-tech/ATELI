import "dotenv/config";
import { z } from "zod";

const Env = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  ATELI_MODEL: z.string().default("claude-opus-4-7"),
  ATELI_MAX_TOKENS: z.coerce.number().int().positive().default(8192),
  ATELI_MAX_TURNS: z.coerce.number().int().positive().default(50),
  ATELI_BASH_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  ATELI_DATA_DIR: z.string().default(".ateli"),
  ATELI_LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),

  ATELI_HTTP_PORT: z.coerce.number().int().positive().default(4000),
  ATELI_HTTP_HOST: z.string().default("0.0.0.0"),

  VOYAGE_API_KEY: z.string().optional(),
  VOYAGE_EMBED_MODEL: z.string().default("voyage-code-3"),

  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),

  GITHUB_TOKEN: z.string().optional(),
  GITHUB_COMMITTER_NAME: z.string().default("ateli-bot"),
  GITHUB_COMMITTER_EMAIL: z
    .string()
    .default("ateli-bot@users.noreply.github.com"),
});

export type Config = z.infer<typeof Env>;

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function requireSlackConfig(c: Config) {
  if (!c.SLACK_BOT_TOKEN || !c.SLACK_APP_TOKEN || !c.SLACK_SIGNING_SECRET) {
    throw new Error(
      "Slack surface requires SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET",
    );
  }
}

export function requireGithubConfig(c: Config) {
  if (!c.GITHUB_TOKEN) {
    throw new Error("GitHub integration requires GITHUB_TOKEN");
  }
}

export function requireVoyageConfig(c: Config) {
  if (!c.VOYAGE_API_KEY) {
    throw new Error("RAG features require VOYAGE_API_KEY");
  }
}
