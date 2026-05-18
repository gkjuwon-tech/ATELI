# ateli

> Hi-end cloud-native AI software engineering agent built on top of frontier models.

## Status

**Phase 0** (Core Agent Loop / CLI) — shipped.
**Phase 1** (Surfaces + Collaboration + RAG) — shipped on this branch.

See [`docs/PHASES.md`](docs/PHASES.md) for the product roadmap and
[`docs/BRAINSTORM.md`](docs/BRAINSTORM.md) for the long-form vision.

## Quick start (Phase 0)

```bash
# 1. install
npm install
npm run build

# 2. configure
cp .env.example .env
# fill in ANTHROPIC_API_KEY (and ATELI_MODEL if you want to override claude-opus-4-7)

# 3. run a task against a workspace
node dist/cli.js run "add a /health endpoint returning {ok:true}" --workspace ./my-app

# 4. inspect what happened
node dist/cli.js tasks
node dist/cli.js show tsk_xxxxxxxxxxxxxxxx
```

## What's inside (Phase 0)

| Piece | File |
|---|---|
| CLI entry (`run` / `tasks` / `show`) | `src/cli.ts` |
| Agent loop with tool-use, usage tracking, event streaming | `src/agent/runner.ts` |
| Anthropic tool schemas | `src/agent/tools.ts` |
| Tool implementations: read / write / edit / bash / grep / glob | `src/tools/*.ts` |
| Workspace path-escape defense | `src/workspace/workspace.ts` |
| SQLite persistence for tasks / messages / tool calls | `src/storage/*.ts` |
| Zod-validated env config | `src/config.ts` |

All tools execute against the real filesystem. `bash` runs through `bash -lc`
with a configurable per-command timeout and 200KB stdout/stderr caps.
Paths supplied by the agent are resolved against the workspace root;
absolute paths, `..` escapes, and out-of-tree symlinks are rejected.

## Configuration

Every config value is sourced from `.env` (Zod-validated, fails loudly on
missing required keys). See [`.env.example`](.env.example) for the full list.

Phase 0 only needs `ANTHROPIC_API_KEY`. Phase 1 additionally needs Slack,
GitHub, and Voyage AI credentials — see `.env.example`.

## Phase 1: HTTP API, Slack, GitHub PRs, RAG

```bash
# 1. add Phase 1 credentials to .env
#    VOYAGE_API_KEY=...   (https://www.voyageai.com/)
#    GITHUB_TOKEN=...     (PAT with `repo` scope)
#    SLACK_BOT_TOKEN=xoxb-...  (only if using Slack)
#    SLACK_APP_TOKEN=xapp-...
#    SLACK_SIGNING_SECRET=...

npm run build

# 2. index a local repo into the RAG store
node dist/cli.js index --repo-id my-app --path ./my-app

# 3. start the HTTP API + dashboard (http://localhost:4000)
node dist/cli.js serve

# 4. (optional) start the Slack bot in another shell
node dist/cli.js slack
# Then in any channel where the bot is invited:
#   @ateli owner/repo  add a /health endpoint returning {ok:true}
# ateli will clone the repo, run, commit, push, and reply with the PR URL.

# 5. trigger a task via HTTP that ends in a real GitHub PR
curl -X POST http://localhost:4000/v1/tasks \
  -H 'content-type: application/json' \
  -d '{"prompt":"add /health endpoint","repo":"owner/name","base":"main","rag_repo":"my-app"}'
```

### What's inside (Phase 1)

| Piece | File |
|---|---|
| Hono HTTP server + dashboard | `src/server.ts`, `src/api/web.ts` |
| REST + SSE event stream for tasks | `src/api/routes/tasks.ts` |
| RAG index/search endpoints | `src/api/routes/rag.ts` |
| In-process pub/sub for agent events | `src/events/bus.ts` |
| Voyage AI `voyage-code-3` embeddings | `src/rag/embed.ts` |
| `sqlite-vec` vector storage | `src/rag/vector.ts` |
| Repo indexer (chunking, hash skip, batch embed) | `src/rag/indexer.ts` |
| Retriever (top-k cosine, repo-scoped) | `src/rag/retriever.ts` |
| Slack Bolt bot (socket mode) | `src/surfaces/slack/{start,bot}.ts` |
| GitHub clone + branch + push + PR | `src/surfaces/github/{clone,pr}.ts` |

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run build       # emit dist/
npm run dev -- run "..."   # run from sources via tsx
```

## License

TBD.
