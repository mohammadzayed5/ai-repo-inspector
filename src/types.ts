export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked";

export type ChangedFile = {
  path: string;
  status: ChangeStatus;
  /** Previous path for renamed or copied files. */
  previousPath?: string;
};

export type ValidationStatus = "passed" | "failed" | "timed_out" | "rejected";

export type ValidationResult = {
  command: string;
  status: ValidationStatus;
  /** Process exit code, or null when the command never finished (timeout, spawn error, rejected). */
  exitCode: number | null;
  durationMs: number;
  /** Combined stdout and stderr in arrival order, capped at maxOutputBytes. */
  output: string;
  truncated: boolean;
};

export type ReportFormat = "markdown" | "json";

export type ReviewRequest = {
  repositoryPath: string;
  baseRef?: string;
  validationCommands?: string[];
  format?: ReportFormat;
  /** Per-command timeout. Default 120000 ms. */
  validationTimeoutMs?: number;
  /** Cap on captured output per command. Default 64 KiB. */
  maxOutputBytes?: number;
  /**
   * When present, a validation command must match an entry exactly or it is
   * reported as "rejected" without running. Undefined means the caller is
   * trusted to run anything (the CLI). Adapters serving untrusted callers
   * (MCP) always pass a list.
   */
  allowedCommands?: readonly string[];
};

export type ReviewSummary = {
  files: Record<ChangeStatus, number> & { total: number };
  validations: Record<ValidationStatus, number> & { total: number };
  /** True only when every validation passed. */
  ok: boolean;
};

export type ReviewData = {
  repositoryPath: string;
  baseRef: string;
  baseCommit: string;
  changedFiles: ChangedFile[];
  validations: ValidationResult[];
  summary: ReviewSummary;
};

export type ReviewResult = {
  data: ReviewData;
  /** The report rendered in the requested format. */
  text: string;
  format: ReportFormat;
};

export type InspectorErrorCode =
  | "BAD_REQUEST"
  | "NOT_A_REPOSITORY"
  | "BAD_BASE_REF"
  | "PATH_NOT_ALLOWED"
  | "GIT_FAILED";

/** An error a caller can act on: the code is stable, the message is for people. */
export class InspectorError extends Error {
  constructor(
    readonly code: InspectorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InspectorError";
  }
}
