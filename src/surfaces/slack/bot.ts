import bolt from "@slack/bolt";
import { loadConfig, requireSlackConfig } from "../../config.js";
import { childLogger } from "../../logger.js";
import { runAgent } from "../../agent/runner.js";
import { cloneRepo } from "../github/clone.js";
import { commitAndOpenPr } from "../github/pr.js";
import { retrieve, formatForPrompt } from "../../rag/retriever.js";

const { App } = bolt;
const log = childLogger({ component: "slack" });

/**
 * Slack message format we accept:
 *   @ateli owner/repo  do the thing
 *   @ateli owner/repo[branch]  do the thing
 *   @ateli rag:my-repo-id owner/repo do the thing
 */
const PARSE = /^(?:rag:(\S+)\s+)?([\w.-]+)\/([\w.-]+)(?:\[([\w./-]+)\])?\s+(.+)$/s;

export function buildApp() {
  const cfg = loadConfig();
  requireSlackConfig(cfg);
  const app = new App({
    token: cfg.SLACK_BOT_TOKEN!,
    signingSecret: cfg.SLACK_SIGNING_SECRET!,
    appToken: cfg.SLACK_APP_TOKEN!,
    socketMode: true,
  });

  app.event("app_mention", async ({ event, client, say }) => {
    // Strip the bot mention prefix.
    const text = event.text.replace(/^<@[A-Z0-9]+>\s*/, "").trim();
    const m = PARSE.exec(text);
    if (!m) {
      await say({
        thread_ts: event.ts,
        text:
          "Usage: `@ateli [rag:<repo-id>] <owner>/<repo>[branch] <task>`\n" +
          "Example: `@ateli acme/api add a /health endpoint returning {ok:true}`",
      });
      return;
    }
    const ragRepo = m[1] || undefined;
    const owner = m[2]!;
    const repo = m[3]!;
    const base = m[4] || "main";
    const prompt = m[5]!.trim();

    const ack = await say({
      thread_ts: event.ts,
      text: `:gear: cloning ${owner}/${repo}@${base}…`,
    });

    let cloned: Awaited<ReturnType<typeof cloneRepo>> | null = null;
    try {
      cloned = await cloneRepo({ owner, repo, base });

      let ragContext: string | undefined;
      if (ragRepo) {
        const chunks = await retrieve({ repoId: ragRepo, query: prompt, k: 8 });
        ragContext = formatForPrompt(chunks);
      }

      await client.chat.update({
        channel: event.channel,
        ts: ack.ts!,
        text: `:robot_face: running agent on ${owner}/${repo}@${base}…`,
      });

      const result = await runAgent({
        prompt,
        workspace: cloned.dir,
        source: "slack",
        source_ref: `${event.channel}:${event.ts}`,
        ragContext,
        onEvent: (ev) => {
          if (ev.type === "tool_call") {
            void client.chat.postMessage({
              channel: event.channel,
              thread_ts: event.ts,
              text: `\`${ev.tool_name}\` ${truncate(JSON.stringify(ev.input), 200)}`,
            });
          }
        },
      });

      const pr = await commitAndOpenPr({
        repoDir: cloned.dir,
        owner,
        repo,
        base,
        branch: `ateli/${result.task.id}`,
        title: truncate(prompt, 70),
        body:
          `Opened by ateli from Slack thread.\n\n` +
          `Prompt:\n> ${prompt}\n\nFinal summary:\n${result.finalText || "(no summary)"}\n`,
      });

      if (pr) {
        await say({ thread_ts: event.ts, text: `:tada: PR: ${pr.url}` });
      } else {
        await say({
          thread_ts: event.ts,
          text: ":information_source: no changes to commit; nothing to PR",
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "slack handler failed");
      await say({ thread_ts: event.ts, text: `:x: error: ${msg}` });
    } finally {
      cloned?.cleanup();
    }
  });

  return app;
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= n ? oneLine : oneLine.slice(0, n - 1) + "…";
}
