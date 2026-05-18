import { spawn } from "node:child_process";
import { z } from "zod";
import type { Workspace } from "../workspace/workspace.js";

const DEFAULT_TIMEOUT_MS = (() => {
  const n = Number(process.env.ATELI_BASH_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
})();

export const bashInput = z.object({
  command: z.string().min(1),
  timeout_ms: z.number().int().positive().max(600_000).optional(),
});

export type BashInput = z.infer<typeof bashInput>;

export interface BashResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
  duration_ms: number;
}

const MAX_OUTPUT_BYTES = 200_000;

export async function bash(
  ws: Workspace,
  raw: unknown,
): Promise<BashResult> {
  const args = bashInput.parse(raw);
  const timeout = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();

  return await new Promise<BashResult>((resolveResult) => {
    const child = spawn("bash", ["-lc", args.command], {
      cwd: ws.root,
      env: { ...process.env, ATELI_WORKSPACE: ws.root },
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, timeout);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout += chunk.toString("utf8");
        if (stdout.length > MAX_OUTPUT_BYTES) {
          stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr += chunk.toString("utf8");
        if (stderr.length > MAX_OUTPUT_BYTES) {
          stderr = stderr.slice(0, MAX_OUTPUT_BYTES);
        }
      }
    });

    const finish = (code: number) => {
      clearTimeout(timer);
      const duration = Date.now() - start;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        stdout += `\n... (truncated, total ${stdoutBytes} bytes)`;
      }
      if (stderrBytes > MAX_OUTPUT_BYTES) {
        stderr += `\n... (truncated, total ${stderrBytes} bytes)`;
      }
      resolveResult({
        stdout,
        stderr,
        exit_code: code,
        timed_out: timedOut,
        duration_ms: duration,
      });
    };

    child.on("error", (err) => {
      clearTimeout(timer);
      resolveResult({
        stdout,
        stderr: stderr + `\nspawn error: ${err.message}`,
        exit_code: -1,
        timed_out: timedOut,
        duration_ms: Date.now() - start,
      });
    });

    child.on("close", (code) => finish(code ?? -1));
  });
}

export function formatBashResult(r: BashResult): string {
  const parts: string[] = [];
  parts.push(`exit_code: ${r.exit_code}${r.timed_out ? " (TIMED OUT)" : ""}`);
  parts.push(`duration: ${r.duration_ms}ms`);
  if (r.stdout) parts.push(`--- stdout ---\n${r.stdout}`);
  if (r.stderr) parts.push(`--- stderr ---\n${r.stderr}`);
  if (!r.stdout && !r.stderr) parts.push("(no output)");
  return parts.join("\n");
}
