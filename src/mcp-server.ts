#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { reviewRepository } from "./core.js";
import { InspectorError } from "./types.js";
import { DEFAULT_MAX_OUTPUT_BYTES } from "./validation.js";

/**
 * Trust boundary. The MCP caller is an AI model, which is less trusted than
 * the person who started this server. That person decides, through the
 * environment, which commands may run and where repositories may live. The
 * model only chooses within those limits.
 *
 *   INSPECTOR_ALLOWED_COMMANDS  newline-separated exact commands (unset = none)
 *   INSPECTOR_ALLOWED_ROOT      directory repositories must live under (default: cwd)
 *   INSPECTOR_MAX_OUTPUT_BYTES  cap per validation command (default 65536)
 */
export type ServerConfig = {
  allowedCommands: string[];
  allowedRoot: string;
  maxOutputBytes: number;
};

export const MAX_REPORT_CHARS = 50_000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const allowedCommands = (env.INSPECTOR_ALLOWED_COMMANDS ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const root = env.INSPECTOR_ALLOWED_ROOT ? resolve(env.INSPECTOR_ALLOWED_ROOT) : process.cwd();
  const maxOutputBytes = Number(env.INSPECTOR_MAX_OUTPUT_BYTES) || DEFAULT_MAX_OUTPUT_BYTES;
  return { allowedCommands, allowedRoot: realpathSync(root), maxOutputBytes };
}

export const reviewInputSchema = {
  repo_path: z.string().min(1).describe("Path to the Git repository to inspect. Must be inside the server's allowed root."),
  base_ref: z.string().optional().describe("Base ref to diff against. Defaults to origin/HEAD, then main, then master."),
  validation_commands: z
    .array(z.string())
    .max(10)
    .optional()
    .describe("Commands to run in the repository. Each must exactly match an entry in the server's allowed list; others are reported as rejected without running."),
  format: z.enum(["markdown", "json"]).optional().describe("Report format. Defaults to markdown."),
  max_output_bytes: z.number().int().positive().optional().describe("Cap on captured output per command. Clamped to the server's limit."),
};

export type ReviewInput = {
  repo_path: string;
  base_ref?: string;
  validation_commands?: string[];
  format?: "markdown" | "json";
  max_output_bytes?: number;
};

function assertInsideRoot(repoPath: string, root: string): string {
  let target: string;
  try {
    target = realpathSync(resolve(repoPath));
  } catch {
    throw new InspectorError("BAD_REQUEST", `Path does not exist: ${repoPath}`);
  }
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new InspectorError("PATH_NOT_ALLOWED", `Repository must be inside ${root}`);
  }
  return target;
}

/** Exported so tests can call the tool logic directly, without a transport. */
export async function handleReview(input: ReviewInput, config: ServerConfig) {
  try {
    const result = await reviewRepository({
      repositoryPath: assertInsideRoot(input.repo_path, config.allowedRoot),
      baseRef: input.base_ref,
      validationCommands: input.validation_commands,
      format: input.format,
      maxOutputBytes: Math.min(input.max_output_bytes ?? config.maxOutputBytes, config.maxOutputBytes),
      allowedCommands: config.allowedCommands,
    });
    const text = result.text.length > MAX_REPORT_CHARS
      ? `${result.text.slice(0, MAX_REPORT_CHARS)}\n[report truncated at ${MAX_REPORT_CHARS} characters]`
      : result.text;
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: {
        baseRef: result.data.baseRef,
        summary: result.data.summary,
        validations: result.data.validations.map(({ command, status, exitCode }) => ({ command, status, exitCode })),
      },
    };
  } catch (error) {
    // Errors are results, not exceptions: an agent can read the code and
    // recover, and no stack trace leaks into its context.
    const text = error instanceof InspectorError
      ? `${error.code}: ${error.message}`
      : `UNEXPECTED: ${error instanceof Error ? error.message : String(error)}`;
    return { content: [{ type: "text" as const, text }], isError: true };
  }
}

export function createServer(config: ServerConfig = loadConfig()): McpServer {
  const server = new McpServer({ name: "repository-inspector", version: "2.1.0" });
  server.registerTool(
    "review_repository",
    {
      title: "Review repository",
      description:
        "Lists files changed against a base branch (committed, staged, unstaged and untracked) and runs allowed validation commands. Returns a Markdown or JSON report plus a structured summary.",
      inputSchema: reviewInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => handleReview(input, config),
  );
  return server;
}

function invokedDirectly(): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  await createServer().connect(new StdioServerTransport());
}
