import { read } from "./read.js";
import { write } from "./write.js";
import { edit } from "./edit.js";
import { bash, formatBashResult } from "./bash.js";
import { grep } from "./grep.js";
import { glob } from "./glob.js";
import type { Workspace } from "../workspace/workspace.js";

export interface ToolExecutionResult {
  output: string;
  is_error: boolean;
}

export async function executeTool(
  name: string,
  input: unknown,
  ws: Workspace,
): Promise<ToolExecutionResult> {
  try {
    switch (name) {
      case "read":
        return { output: read(ws, input), is_error: false };
      case "write":
        return { output: write(ws, input), is_error: false };
      case "edit":
        return { output: edit(ws, input), is_error: false };
      case "bash": {
        const r = await bash(ws, input);
        return {
          output: formatBashResult(r),
          is_error: r.exit_code !== 0 || r.timed_out,
        };
      }
      case "grep":
        return { output: await grep(ws, input), is_error: false };
      case "glob":
        return { output: glob(ws, input), is_error: false };
      default:
        return { output: `unknown tool: ${name}`, is_error: true };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `error: ${msg}`, is_error: true };
  }
}
