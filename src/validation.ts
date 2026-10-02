import { spawn } from "node:child_process";
import type { ValidationResult } from "./types.js";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

export type ValidationOptions = {
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Exact-match allowlist. Undefined means the caller may run anything. */
  allowedCommands?: readonly string[];
};

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    // Negative pid targets the whole process group (we spawn detached on
    // POSIX), so "npm test" -> node grandchildren die too and cannot keep the
    // pipes open after the shell is gone.
    if (process.platform === "win32") process.kill(pid, "SIGKILL");
    else process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/**
 * Runs one validation command and always resolves.
 *
 * - exit 0            -> "passed"
 * - non-zero exit     -> "failed" with the exit code
 * - timeout           -> "timed_out", process group killed
 * - spawn error       -> "failed" with exitCode null
 * - not on allowlist  -> "rejected", never spawned
 *
 * A failing check is information for the report, not a reason to abort the
 * review. Output is capped so a chatty suite cannot flood a file or an AI
 * client's context window.
 */
export function runValidation(
  command: string,
  cwd: string,
  options: ValidationOptions = {},
): Promise<ValidationResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const trimmed = command.trim();

  if (options.allowedCommands && !options.allowedCommands.map((c) => c.trim()).includes(trimmed)) {
    const allowed = options.allowedCommands.length ? options.allowedCommands.join(", ") : "(none configured)";
    return Promise.resolve({
      command,
      status: "rejected",
      exitCode: null,
      durationMs: 0,
      output: `Command is not on the allowed list. Allowed: ${allowed}`,
      truncated: false,
    });
  }

  const started = Date.now();
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let captured = 0;
    let truncated = false;
    let settled = false;

    // The shell is deliberate: CLI users write "npm test -- --run" or
    // "A=1 make check". Who may pass a command at all is decided by the
    // adapter through allowedCommands, not by parsing the string here.
    const child = spawn(trimmed, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const capture = (chunk: Buffer) => {
      if (captured >= maxOutputBytes) {
        truncated = true;
        return; // keep draining so the child never blocks on a full pipe
      }
      const room = maxOutputBytes - captured;
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (piece.length < chunk.length) truncated = true;
      chunks.push(piece);
      captured += piece.length;
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    const finish = (status: ValidationResult["status"], exitCode: number | null, note?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let output = Buffer.concat(chunks).toString("utf8");
      if (truncated) output += `\n[output truncated at ${maxOutputBytes} bytes]`;
      if (note) output = output ? `${output}\n${note}` : note;
      resolve({ command, status, exitCode, durationMs: Date.now() - started, output, truncated });
    };

    const timer = setTimeout(() => {
      killTree(child.pid);
      finish("timed_out", null, `Timed out after ${timeoutMs} ms`);
    }, timeoutMs);

    child.on("error", (error) => finish("failed", null, `Could not start command: ${error.message}`));
    child.on("close", (code) => finish(code === 0 ? "passed" : "failed", code));
  });
}

/** Sequential on purpose: outputs never interleave and checks never race for ports or caches. */
export async function runValidations(
  commands: string[],
  cwd: string,
  options: ValidationOptions = {},
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  for (const command of commands) {
    results.push(await runValidation(command, cwd, options));
  }
  return results;
}
