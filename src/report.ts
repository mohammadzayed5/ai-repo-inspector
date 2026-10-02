import type { ChangedFile, ReportFormat, ReviewData, ValidationResult } from "./types.js";

/** A fence longer than any run of backticks in the body, so output can never close it early. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

function describeFile(file: ChangedFile): string {
  return file.previousPath
    ? `${file.path} (${file.status} from ${file.previousPath})`
    : `${file.path} (${file.status})`;
}

function describeValidation(result: ValidationResult): string {
  const exit = result.exitCode === null ? "" : `exit ${result.exitCode}, `;
  return `${result.status} (${exit}${result.durationMs} ms)`;
}

function summaryLine(data: ReviewData): string {
  const { files, validations } = data.summary;
  const parts = (["added", "modified", "deleted", "renamed", "copied", "untracked"] as const)
    .filter((status) => files[status] > 0)
    .map((status) => `${files[status]} ${status}`);
  const fileText = `${files.total} file${files.total === 1 ? "" : "s"}${parts.length ? ` (${parts.join(", ")})` : ""}`;
  const validationText = validations.total === 0
    ? "no validations run"
    : `validations: ${validations.passed} passed, ${validations.failed} failed, ${validations.timed_out} timed out, ${validations.rejected} rejected`;
  return `${fileText}; ${validationText}`;
}

export function markdownReport(data: ReviewData): string {
  const lines = [
    `# Review Report: ${data.repositoryPath}`,
    "",
    `Base: ${data.baseRef} (${data.baseCommit.slice(0, 7)})`,
    "",
    summaryLine(data),
    "",
    "## Changed files",
  ];
  if (data.changedFiles.length === 0) lines.push("_No changes._");
  for (const file of data.changedFiles) lines.push(`- ${describeFile(file)}`);

  lines.push("", "## Validation output");
  if (data.validations.length === 0) lines.push("_No validation commands were run._");
  for (const result of data.validations) {
    const body = result.output.length ? result.output : "(no output)";
    const fence = fenceFor(body);
    lines.push(`### ${result.command} — ${describeValidation(result)}`, fence, body, fence, "");
  }
  return lines.join("\n").replace(/\n+$/, "") + "\n";
}

export function jsonReport(data: ReviewData): string {
  return JSON.stringify(data, null, 2) + "\n";
}

export function renderReport(data: ReviewData, format: ReportFormat): string {
  return format === "json" ? jsonReport(data) : markdownReport(data);
}
