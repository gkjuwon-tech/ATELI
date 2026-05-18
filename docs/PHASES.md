# ateli — Product Development Phases

> Investor / GTM stuff lives in [`BRAINSTORM.md`](./BRAINSTORM.md). This doc is **only** about what we ship.

Two phases, both fully working (no mocks, no simulations, real APIs end-to-end).

---

## Phase 0 — Core Agent Loop (CLI)

**Goal:** a real CLI binary that takes a natural-language task and a workspace, runs a tool-using Claude Opus loop, and actually modifies the workspace.

### Hard requirements
- Real `@anthropic-ai/sdk` calls (no stubbed responses)
- Real filesystem tools that read/write/edit your disk
- Real `bash -lc` execution with timeout + output truncation
- Path safety: every tool path resolved against a workspace root, escapes rejected (including via symlinks)
- Persistent task log in sqlite (tasks, messages, tool calls, token usage)
- `.env` based config with Zod validation — never commit secrets
- Strict TypeScript build, `npm run typecheck` passes

### Deliverables (this phase)
- `src/cli.ts` — `ateli run`, `ateli tasks`, `ateli show`
- `src/agent/runner.ts` — tool-use loop with usage tracking + event streaming
- `src/agent/tools.ts` — Anthropic tool schemas (read/write/edit/bash/grep/glob)
- `src/agent/prompts.ts` — system prompt
- `src/tools/*.ts` — real implementations
- `src/workspace/workspace.ts` — path-escape defense
- `src/storage/{db,tasks}.ts` — sqlite persistence
- `src/config.ts` — Zod-validated env loading
- `src/logger.ts` — pino logger

### How a user runs it
```bash
cp .env.example .env
# fill in ANTHROPIC_API_KEY
npm install
npm run build
node dist/cli.js run "add a /health endpoint that returns {ok:true}" --workspace ./my-app
node dist/cli.js tasks
node dist/cli.js show tsk_xxx
```

---

## Phase 1 — Surfaces, Collaboration, RAG

**Goal:** the same agent reachable from Slack, callable over HTTP, capable of opening real GitHub PRs, with retrieval-augmented context from a code index.

### Hard requirements
- HTTP API server (`hono`) exposing task create / read / event stream
- Slack bot (`@slack/bolt` Socket Mode) — real OAuth tokens, real channel messages
- GitHub integration (`@octokit/rest`) — real repo clone, branch, commit, push, PR
- RAG indexer using Voyage AI `voyage-code-3` embeddings and `sqlite-vec` storage
- Top-k retrieval injected into the agent's system prompt before each task
- Minimal web dashboard served from the HTTP server (task list + live log)
- All credentials in `.env`, never logged

### Deliverables (this phase)
- `src/server.ts` — HTTP entry
- `src/api/routes/tasks.ts` — REST + SSE event stream
- `src/api/web.ts` — embedded dashboard
- `src/surfaces/slack/{start,bot}.ts` — Slack adapter
- `src/surfaces/github/{clone,pr}.ts` — clone repo + open PR
- `src/rag/{indexer,embed,vector,retriever}.ts` — real embeddings + vector search
- `src/cli.ts` extensions — `ateli index`, `ateli serve`

### How a user runs it
```bash
# index a repo for RAG
node dist/cli.js index --repo ./my-app

# start the HTTP API + dashboard
npm run serve
# -> http://localhost:4000

# start the Slack bot
npm run slack
# -> @ateli in any channel; ateli replies, opens a PR, posts the URL

# trigger a task that ends in a real GitHub PR
curl -X POST http://localhost:4000/v1/tasks \
  -H 'content-type: application/json' \
  -d '{"prompt":"add /health endpoint","repo":"owner/name","base":"main"}'
```

### Out of scope (deliberately)
- Multi-tenant SaaS, billing, SSO/SCIM — Phase 2+
- BYOC / VPC deploys — Phase 2+
- Time-Travel debugger, Parallel Reality testing, etc. (see BRAINSTORM) — Phase 3+
- Self-hosted model routing — Phase 2+
