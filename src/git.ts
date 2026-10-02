import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { ChangedFile, ChangeStatus } from "./types.js";
import { InspectorError } from "./types.js";

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Every git call goes through here. `core.fsmonitor=false` stops a repo's own
 * .git/config from running a hook binary when we inspect it, and the large
 * buffer keeps big diffs from throwing ENOBUFS.
 */
function git(repositoryPath: string, args: string[]): string {
  try {
    return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd: repositoryPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: MAX_BUFFER,
    });
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String((error as { stderr: unknown }).stderr) : "";
    const detail = stderr.trim() || (error instanceof Error ? error.message : String(error));
    throw new InspectorError("GIT_FAILED", `git ${args[0]} failed: ${detail}`);
  }
}

function tryGit(repositoryPath: string, args: string[]): string | undefined {
  try {
    return git(repositoryPath, args).trim();
  } catch {
    return undefined;
  }
}

export function assertRepository(repositoryPath: string): void {
  if (!existsSync(repositoryPath)) {
    throw new InspectorError("BAD_REQUEST", `Path does not exist: ${repositoryPath}`);
  }
  if (tryGit(repositoryPath, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    throw new InspectorError("NOT_A_REPOSITORY", `Not a Git repository: ${repositoryPath}`);
  }
}

function refExists(repositoryPath: string, ref: string): boolean {
  return tryGit(repositoryPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) !== undefined;
}

/**
 * Explicit ref (verified, and never something git could read as an option),
 * then the remote default branch, then main, then master.
 */
export function resolveBaseRef(repositoryPath: string, baseRef?: string): string {
  if (baseRef !== undefined) {
    const ref = baseRef.trim();
    if (!ref || ref.startsWith("-")) {
      throw new InspectorError("BAD_BASE_REF", `Invalid base ref: ${JSON.stringify(baseRef)}`);
    }
    if (!refExists(repositoryPath, ref)) throw new InspectorError("BAD_BASE_REF", `Base ref not found: ${ref}`);
    return ref;
  }
  const remoteHead = tryGit(repositoryPath, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (remoteHead) {
    const short = remoteHead.replace(/^refs\/remotes\//, "");
    if (refExists(repositoryPath, short)) return short;
  }
  for (const candidate of ["main", "master"]) {
    if (refExists(repositoryPath, candidate)) return candidate;
  }
  throw new InspectorError(
    "BAD_BASE_REF",
    "Could not find a base branch (tried origin/HEAD, main, master). Pass a base ref explicitly.",
  );
}

/** The commit the branch forked from, so the review covers only this branch's work. */
export function mergeBase(repositoryPath: string, baseRef: string): string {
  return git(repositoryPath, ["merge-base", baseRef, "HEAD"]).trim();
}

const STATUS_BY_CODE: Record<string, ChangeStatus> = {
  A: "added",
  D: "deleted",
  M: "modified",
  T: "modified",
  U: "modified",
  R: "renamed",
  C: "copied",
};

/** Parses `git diff --name-status -z` output: NUL-separated, renames and copies carry two paths. */
export function parseNameStatus(raw: string): ChangedFile[] {
  const fields = raw.split("\0");
  if (fields.length && fields[fields.length - 1] === "") fields.pop();
  const files: ChangedFile[] = [];
  let index = 0;
  while (index < fields.length) {
    const code = fields[index++];
    if (!code) continue;
    const status = STATUS_BY_CODE[code[0]] ?? "modified";
    if (status === "renamed" || status === "copied") {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (path !== undefined) files.push({ path, status, previousPath });
    } else {
      const path = fields[index++];
      if (path !== undefined) files.push({ path, status });
    }
  }
  return files;
}

/**
 * One diff from the merge base to the work tree covers committed, staged and
 * unstaged changes as a single net result, plus untracked files from ls-files.
 */
export function changedFiles(repositoryPath: string, baseCommit: string): ChangedFile[] {
  const tracked = parseNameStatus(git(repositoryPath, ["diff", "--name-status", "-z", "-M", baseCommit]));
  const untracked = git(repositoryPath, ["ls-files", "-z", "--others", "--exclude-standard"])
    .split("\0")
    .filter(Boolean)
    .map((path): ChangedFile => ({ path, status: "untracked" }));

  const byPath = new Map<string, ChangedFile>();
  for (const file of [...untracked, ...tracked]) byPath.set(file.path, file);
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}
