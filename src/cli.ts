#!/usr/bin/env node
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs as nodeParseArgs } from "node:util";
import { reviewRepository } from "./core.js";
import type { ReportFormat } from "./types.js";
import { InspectorError } from "./types.js";

export type CliArgs = {
  command: string;
  repositoryPath?: string;
  baseRef?: string;
  format: ReportFormat;
  output: string;
  timeoutMs?: number;
  validations: string[];
  help: boolean;
};

export const USAGE = `Usage: inspector review --repo <path> [options]

Options:
  --repo <path>          Repository to inspect (required)
  --base-ref <ref>       Base to diff against (default: origin/HEAD, main, or master)
  --validate <command>   Validation command to run in the repo; repeatable
  --format <fmt>         markdown (default) or json
  --output <path>        Report file (default: review-report.md); use - for stdout
  --timeout <ms>         Per-command timeout in milliseconds (default: 120000)
  --help                 Show this help

Exit codes: 0 all validations passed, 1 a validation did not pass, 2 usage or inspection error.`;

/** Strict parsing: unknown flags, missing values and bad enums are errors, not surprises. */
export function parseArgs(argv: string[]): CliArgs {
  let parsed: ReturnType<typeof nodeParseArgs>;
  try {
    parsed = nodeParseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: {
        repo: { type: "string" },
        "base-ref": { type: "string" },
        validate: { type: "string", multiple: true },
        format: { type: "string" },
        output: { type: "string", default: "review-report.md" },
        timeout: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    throw new InspectorError("BAD_REQUEST", error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  const format = (values.format as string | undefined) ?? "markdown";
  if (format !== "markdown" && format !== "json") {
    throw new InspectorError("BAD_REQUEST", `--format must be markdown or json, got ${format}`);
  }
  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    timeoutMs = Number(values.timeout);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new InspectorError("BAD_REQUEST", "--timeout must be a positive number of milliseconds");
    }
  }
  return {
    command: positionals[0] ?? "",
    repositoryPath: values.repo as string | undefined,
    baseRef: values["base-ref"] as string | undefined,
    format,
    output: values.output as string,
    timeoutMs,
    validations: (values.validate as string[] | undefined) ?? [],
    help: Boolean(values.help),
  };
}

export async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.command !== "review" || !args.repositoryPath) {
    console.error(USAGE);
    return 2;
  }

  try {
    const result = await reviewRepository({
      repositoryPath: args.repositoryPath,
      baseRef: args.baseRef,
      validationCommands: args.validations,
      format: args.format,
      validationTimeoutMs: args.timeoutMs,
    });
    if (args.output === "-") {
      process.stdout.write(result.text);
    } else {
      writeFileSync(args.output, result.text, "utf8");
    }
    const { files, validations } = result.data.summary;
    const target = args.output === "-" ? "stdout" : args.output;
    // Summary goes to stderr so `--output -` keeps stdout clean for pipes.
    console.error(
      `${files.total} file(s) changed; validations: ${validations.passed} passed, ${validations.total - validations.passed} not passed -> ${target}`,
    );
    return result.data.summary.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof InspectorError) {
      console.error(`${error.code}: ${error.message}`);
      return 2;
    }
    console.error("Fatal error:", error instanceof Error ? error.message : error);
    return 2;
  }
}

function invokedDirectly(): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = await main(process.argv.slice(2));
}
