# ateli

> Hi-end cloud-native AI software engineering agent built on top of frontier models.

## Status

**Phase 0** (Core Agent Loop / CLI) — shipped.
**Phase 1** (Surfaces + Collaboration + RAG) — in progress on this branch.

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

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run build       # emit dist/
npm run dev -- run "..."   # run from sources via tsx
```

## License

TBD.
