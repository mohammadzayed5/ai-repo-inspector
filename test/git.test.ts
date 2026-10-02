import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRepository, changedFiles, mergeBase, parseNameStatus, resolveBaseRef } from "../src/git.js";
import { InspectorError } from "../src/types.js";

const dirs: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
function g(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

let repo: string;

beforeAll(() => {
  repo = tmp("inspector-repo-");
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "keep.txt"), "base\n");
  writeFileSync(join(repo, "old.txt"), "same content that git can track across a rename\n");
  writeFileSync(join(repo, "gone.txt"), "to delete\n");
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", "base");
  g(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "keep.txt"), "changed\n");
  writeFileSync(join(repo, "new.txt"), "added\n");
  g(repo, "mv", "old.txt", "renamed.txt");
  g(repo, "rm", "-q", "gone.txt");
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", "feature work");
  writeFileSync(join(repo, "scratch.txt"), "untracked\n");
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("changedFiles", () => {
  it("reports added, modified, deleted, renamed and untracked files against the merge base", () => {
    const base = mergeBase(repo, resolveBaseRef(repo));
    const files = changedFiles(repo, base);
    const byPath = Object.fromEntries(files.map((file) => [file.path, file]));
    expect(byPath["new.txt"].status).toBe("added");
    expect(byPath["keep.txt"].status).toBe("modified");
    expect(byPath["gone.txt"].status).toBe("deleted");
    expect(byPath["renamed.txt"].status).toBe("renamed");
    expect(byPath["renamed.txt"].previousPath).toBe("old.txt");
    expect(byPath["scratch.txt"].status).toBe("untracked");
    expect(files.map((file) => file.path)).toEqual([...files.map((file) => file.path)].sort());
  });
});

describe("resolveBaseRef", () => {
  it("falls back to main when no ref is given", () => {
    expect(resolveBaseRef(repo)).toBe("main");
  });
  it("rejects a missing ref", () => {
    expect(() => resolveBaseRef(repo, "nope")).toThrowError(InspectorError);
    expect(() => resolveBaseRef(repo, "nope")).toThrow(/Base ref not found/);
  });
  it("rejects a ref that git would read as an option", () => {
    try {
      resolveBaseRef(repo, "--output=/tmp/x");
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as InspectorError).code).toBe("BAD_BASE_REF");
    }
  });
});

describe("assertRepository", () => {
  it("throws NOT_A_REPOSITORY for a plain directory", () => {
    const plain = tmp("inspector-plain-");
    try {
      assertRepository(plain);
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as InspectorError).code).toBe("NOT_A_REPOSITORY");
    }
  });
  it("throws BAD_REQUEST for a missing path", () => {
    try {
      assertRepository(join(tmpdir(), "inspector-does-not-exist-" + Date.now()));
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as InspectorError).code).toBe("BAD_REQUEST");
    }
  });
});

describe("parseNameStatus", () => {
  it("handles two-path rename records and the trailing NUL", () => {
    const raw = "M\0a.ts\0R100\0old.ts\0new.ts\0A\0b.ts\0";
    expect(parseNameStatus(raw)).toEqual([
      { path: "a.ts", status: "modified" },
      { path: "new.ts", status: "renamed", previousPath: "old.ts" },
      { path: "b.ts", status: "added" },
    ]);
  });
});
