import { EventEmitter } from "node:events";
import type { AgentEvent } from "../agent/runner.js";

/**
 * Process-local pub/sub keyed by task_id. Used to fan agent events
 * out to SSE subscribers and surface adapters (Slack progress posts, etc).
 */
class TaskEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }

  publish(taskId: string, event: AgentEvent) {
    this.emit(taskId, event);
    this.emit("*", taskId, event);
  }

  subscribe(taskId: string, listener: (event: AgentEvent) => void): () => void {
    this.on(taskId, listener);
    return () => this.off(taskId, listener);
  }

  subscribeAll(listener: (taskId: string, event: AgentEvent) => void): () => void {
    this.on("*", listener);
    return () => this.off("*", listener);
  }
}

export const eventBus = new TaskEventBus();
