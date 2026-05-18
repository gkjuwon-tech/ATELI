import { buildApp } from "./bot.js";
import { logger } from "../../logger.js";

const app = buildApp();
await app.start();
logger.info("ateli slack bot is running (socket mode)");
