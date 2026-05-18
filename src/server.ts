import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { tasksRouter } from "./api/routes/tasks.js";
import { ragRouter } from "./api/routes/rag.js";
import { DASHBOARD_HTML } from "./api/web.js";

const cfg = loadConfig();
const app = new Hono();

app.get("/", (c) => c.html(DASHBOARD_HTML));
app.get("/healthz", (c) => c.json({ ok: true }));
app.route("/v1/tasks", tasksRouter);
app.route("/v1/rag", ragRouter);

const port = cfg.ATELI_HTTP_PORT;
const host = cfg.ATELI_HTTP_HOST;

serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  logger.info({ port: info.port, host }, "ateli server listening");
});
