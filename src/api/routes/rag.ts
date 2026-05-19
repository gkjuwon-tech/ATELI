import { Hono } from "hono";
import { z } from "zod";
import { indexRepo } from "../../rag/indexer.js";
import { retrieve } from "../../rag/retriever.js";
import { auth } from "../middleware/auth.js";

const Index = z.object({
  repo_id: z.string().min(1),
  path: z.string().min(1),
});

const Search = z.object({
  repo_id: z.string().min(1),
  query: z.string().min(1),
  k: z.number().int().positive().max(50).optional(),
});

export const ragRouter = new Hono();

ragRouter.post("/index", auth({ scope: "write" }), async (c) => {
  const parsed = Index.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400);
  const stats = await indexRepo({
    repoRoot: parsed.data.path,
    repoId: parsed.data.repo_id,
  });
  return c.json({ stats });
});

ragRouter.post("/search", auth({ scope: "read" }), async (c) => {
  const parsed = Search.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400);
  const results = await retrieve({
    repoId: parsed.data.repo_id,
    query: parsed.data.query,
    k: parsed.data.k,
  });
  return c.json({ results });
});
