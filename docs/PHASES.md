# ateli — Product Development Phases

> Investor / GTM stuff lives in [`BRAINSTORM.md`](./BRAINSTORM.md). This doc is **only** about what we ship.

All phases ship fully working software (no mocks, no simulations, real APIs end-to-end).

---

## Phase 0 — Core Agent Loop (CLI) ✅ shipped

A real CLI that takes a natural-language task + a workspace, runs a Claude tool-use loop, and modifies the workspace.

**Delivered:**
- Real `@anthropic-ai/sdk` calls, no stubs
- Tools: read / write / edit / bash / grep / glob (all hit disk)
- Workspace path-escape defense (absolute, `..`, out-of-tree symlinks rejected)
- SQLite persistence: tasks, messages, tool_calls, token usage
- Zod-validated `.env`; secrets never committed
- `ateli run` / `tasks` / `show`

---

## Phase 1 — Surfaces, Collaboration, RAG ✅ shipped

Same agent reachable from Slack, callable over HTTP, with PR creation + retrieval-augmented context.

**Delivered:**
- `hono` HTTP API + SSE event stream + embedded web dashboard
- `@slack/bolt` socket-mode bot (`@ateli owner/repo task`)
- `@octokit/rest` clone → branch → push → draft PR
- Voyage `voyage-code-3` embeddings + `sqlite-vec` storage
- In-process event bus fanning agent events to all surfaces
- `ateli index` / `serve` / `slack`

---

## Phase 2 — Smart Agent (9 features) ✅ shipped

> *"Same model, smarter usage."*

**Goal:** the same Claude Opus, but ateli wields it dramatically better than competitors. Sessions, cost-aware routing, planning, self-critique, AST-aware retrieval, personalization, auth, durable workers, real-time collab.

### 2.1 Sessions & Multi-Turn

- New table `sessions(id, source, source_ref, user_id, created_at, last_task_id, summary)`.
- `tasks.session_id` FK. Slack thread, HTTP `session_id`, CLI `--session <id>` all map onto the same row.
- New task continuing a session prepends the prior assistant + tool messages.
- Coarse auto-summary: every successful task's final text is stored on `sessions.summary` for cheap reuse in the next turn's system prompt.

### 2.2 Cost-Aware Model Routing

- `src/agent/router.ts`: a cheap classifier (Haiku) labels each new task as `trivial | medium | complex | architectural`.
- Routing table mapping label → model + `max_tokens` + thinking mode.
- Per-task budget cap (`ATELI_BUDGET_PER_TASK_USD` env, `--budget` CLI flag, or `budget_usd` over HTTP).
- Mid-run breaker: every turn we add tokens × pricing to a running tally; at 80 % of the cap we emit `budget_warn`, at 100 % we stop and finish with `budget_exceeded`.

### 2.3 Self-Critique Loop

- After main agent reports `end_turn`, spawn 4 critic personas in parallel:
  - **Linus** — code quality, naming, complexity.
  - **OWASP** — secret leaks, injection, authn/z.
  - **Brendan Gregg** — perf hot paths, N+1, blocking I/O.
  - **Junior** — readability for a 6-month engineer.
- Each critic returns `{ pass: boolean, issues: [...] }`. If any issue is warn/error, the main agent gets the aggregated feedback and runs one more revision pass.

### 2.4 AST-Aware RAG Chunking

- `src/rag/chunker.ts`: boundary-aware chunker. Recognizes function / class / interface declarations for TS / JS / Python / Go / Rust / Java / Kotlin / Ruby via regex.
- Each chunk records its symbol + kind so retrieval can show `function foo`, `class Bar`, etc.
- Falls back to overlapping line windows for unsupported file types.

### 2.5 Plan → Execute Mode

- `--plan` flag (or `plan_mode: true` over HTTP) runs a Sonnet planner first to emit a checklist with acceptance criteria.
- Checklist persists in `tasks.plan_json` so the executor (and the dashboard) can show it.
- Planner cost rolls into the same `cost_usd` running total.

### 2.6 Personal Context Layer

- New table `user_profiles(user_id, prefs JSON, learned_style JSON, updated_at)`.
- `getProfile(user_id)` + `profileForPrompt(p)` render a short block injected into the system prompt: "User style: indent=tabs, semicolons=no, …".
- Populated by `upsertProfile`; future work (Phase 4+) wires the auto-learner from merged PR edits.

### 2.7 Auth

- Bearer-token middleware on `/v1/*`. Tokens stored hashed (SHA-256) in `api_tokens(...)`.
- `ateli token create --user <id> --name <name> --scope read|write|admin` issues a token (printed once).
- `ATELI_REQUIRE_AUTH=1` flips the middleware from permissive to strict.

### 2.8 Background Workers

- New `jobs` table acts as a durable queue. `claimNextJob()` uses `UPDATE … RETURNING` for atomic row-locking.
- Heartbeat-based reclamation: jobs whose worker stops heart-beating for 60 s are returned to the queue automatically.
- Two run modes:
  - **embedded:** `ateli serve` auto-starts a worker in-process (default, dev-friendly).
  - **separated:** `ATELI_DISABLE_EMBEDDED_WORKER=1` + `ateli worker --concurrency 4` for prod.

### 2.9 Real-Time Collaboration

- `POST /v1/tasks/:id/interject` queues a user message that the running agent reads at the start of its next turn.
- Dashboard exposes an interject box while a task is running.
- Slack: any new mention in the same thread already maps to the same session, so follow-up guidance flows through normal channel chat.

### 2.10 *(VS Code extension — deferred to Phase 4)*

Originally listed here; deliberately pushed past Phase 3 to keep this phase focused on backend correctness. Tracked separately as `ateli-vscode`.

### Build order

1. Sessions (foundation, 2.1)
2. Auth (gate everything else, 2.7)
3. Background Workers (durability, 2.8)
4. Cost-Aware Routing (2.2)
5. Self-Critique (2.3)
6. Plan→Execute (2.5)
7. AST-Aware RAG (2.4)
8. Personal Context (2.6)
9. Real-Time Collab (2.9)

---

## Phase 3 — Time-Travel Debugger (one weapon, deep)

> *"The single feature that makes Devin look like a toy."*

**Goal:** ateli can record a deterministic, fully-queryable execution trace of arbitrary Node.js and Python programs, then answer questions about state at any point in that trace.

This is intentionally narrow. We do one thing far better than anyone else.

### 3.1 Recorder — Node.js

- Use the Chrome DevTools Protocol (CDP) via the built-in `node --inspect` channel.
- Hook `Debugger.scriptParsed` to register every loaded source.
- Set instrumentation breakpoints on function entry/exit; capture `Runtime.callFunctionOn` to dump locals snapshot.
- Stream events into sqlite-vec + a flat `trace_events` table:
  ```
  trace_events(task_id, ts_ns, kind, fn, file, line, locals_json, ret_json)
  ```
- Memory pressure: locals are recorded as shallow JSON with depth=3 and per-value size cap.
- Activated via tool `time_travel.start({ cmd: "npm test" })`.

### 3.2 Recorder — Python

- `sys.settrace` + `bdb` for line/call/return events.
- Same `trace_events` schema.
- Same activation surface (`time_travel.start({ cmd: "pytest" })`).

### 3.3 Query Tools

Exposed to the agent as Anthropic tools:

- `time_travel.find_when(predicate)` — agent supplies a JS expression evaluated against locals at each event; first matching event returned.
- `time_travel.timeline({ file, line })` — every time that line was executed.
- `time_travel.replay_from(ts_ns, steps)` — step-by-step playback.
- `time_travel.call_stack_at(ts_ns)` — full stack trace.
- `time_travel.diff_state(ts_a, ts_b)` — local-variable diff between two moments.

### 3.4 Indexing for Fast Query

- Per-task `trace_index` table mapping (file, line) → ordered list of `ts_ns` for O(log n) seek.
- Optional vector embedding of "narrative summary" per 1 000-event window for semantic search across very long runs ("when did the cache get invalidated?").

### 3.5 Cost & Safety

- Tracing is opt-in per task (CLI flag, HTTP body field).
- Hard cap on disk usage (default 500 MB / task); when reached we keep only the most recent window.
- Sandbox the traced program in a Firecracker VM (Phase 3 introduces the Firecracker integration that Phase 4 multi-tenancy will reuse).

### Out of scope (Phase 3)

- Go / Rust / Java tracing — deferred.
- Time-travel for compiled binaries — deferred (would need DynamoRIO or rr).
- Distributed trace correlation (multi-process / multi-service) — Phase 4+.

---

## Phase 4+ — Deferred backlog

Order TBD; pulled from `BRAINSTORM.md`.

- VS Code extension (`ateli-vscode`)
- Parallel Reality Testing
- Synthetic User Swarm
- Visual Regression Agent
- Dry-Run Theater (DB / infra)
- Self-Healing Infrastructure
- Knowledge Graph Builder
- Meta-Agent (agent that builds agents)
- Multi-tenant SaaS / BYOC / SSO+SCIM
