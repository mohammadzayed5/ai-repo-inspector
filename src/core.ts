import { resolve } from "node:path";
import { assertRepository, changedFiles, mergeBase, resolveBaseRef } from "./git.js";
import { renderReport } from "./report.js";
import type { ChangeStatus, ReviewData, ReviewRequest, ReviewResult, ValidationStatus } from "./types.js";
import { InspectorError } from "./types.js";
import { runValidations } from "./validation.js";

const FILE_STATUSES: ChangeStatus[] = ["added", "modified", "deleted", "renamed", "copied", "untracked"];
const VALIDATION_STATUSES: ValidationStatus[] = ["passed", "failed", "timed_out", "rejected"];

/**
 * The one review pipeline every adapter calls. Policy (who may run which
 * commands, how much output to keep) arrives as request fields, so the CLI
 * and the MCP server cannot behave differently by accident.
 */
export async function reviewRepository(request: ReviewRequest): Promise<ReviewResult> {
  if (!request.repositoryPath) throw new InspectorError("BAD_REQUEST", "repositoryPath is required");
  const format = request.format ?? "markdown";
  if (format !== "markdown" && format !== "json") {
    throw new InspectorError("BAD_REQUEST", `format must be markdown or json, got ${String(format)}`);
  }

  const repositoryPath = resolve(request.repositoryPath);
  assertRepository(repositoryPath);
  const baseRef = resolveBaseRef(repositoryPath, request.baseRef);
  const baseCommit = mergeBase(repositoryPath, baseRef);
  const files = changedFiles(repositoryPath, baseCommit);

  const validations = await runValidations(request.validationCommands ?? [], repositoryPath, {
    timeoutMs: request.validationTimeoutMs,
    maxOutputBytes: request.maxOutputBytes,
    allowedCommands: request.allowedCommands,
  });

  const fileCounts = Object.fromEntries(FILE_STATUSES.map((s) => [s, 0])) as Record<ChangeStatus, number>;
  for (const file of files) fileCounts[file.status] += 1;
  const validationCounts = Object.fromEntries(VALIDATION_STATUSES.map((s) => [s, 0])) as Record<ValidationStatus, number>;
  for (const result of validations) validationCounts[result.status] += 1;

  const data: ReviewData = {
    repositoryPath,
    baseRef,
    baseCommit,
    changedFiles: files,
    validations,
    summary: {
      files: { ...fileCounts, total: files.length },
      validations: { ...validationCounts, total: validations.length },
      ok: validations.every((result) => result.status === "passed"),
    },
  };
  return { data, text: renderReport(data, format), format };
}
