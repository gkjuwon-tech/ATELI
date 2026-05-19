import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { tasksRouter } from "./api/routes/tasks.js";
import { ragRouter } from "./api/routes/rag.js";
import { DASHBOARD_HTML } from "./api/web.js";
import { startWorker } from "./worker.js";

const cfg = loadConfig();
const app = new Hono();

app.get("/", (c) => c.html(DASHBOARD_HTML));
app.get("/healthz", (c) => c.json({ ok: true }));
app.route("/v1/tasks", tasksRouter);
app.route("/v1/rag", ragRouter);

const port = cfg.ATELI_HTTP_PORT;
const host = cfg.ATELI_HTTP_HOST;

// By default the server runs an embedded worker so jobs enqueued via the
// dashboard get picked up without an extra process. Set
// ATELI_DISABLE_EMBEDDED_WORKER=1 when you run dedicated workers.
const embeddedWorker =
  process.env.ATELI_DISABLE_EMBEDDED_WORKER === "1" ? null : startWorker({ concurrency: 1 });

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  logger.info({ port: info.port, host, embedded_worker: !!embeddedWorker }, "ateli server listening");
});

async function shutdown() {
  logger.info("shutting down");
  if (embeddedWorker) await embeddedWorker.stop();
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
