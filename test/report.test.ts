import { describe, expect, it } from "vitest";
import { fenceFor, jsonReport, markdownReport } from "../src/report.js";
import type { ReviewData, ValidationResult } from "../src/types.js";

function validation(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return { command: "npm test", status: "passed", exitCode: 0, durationMs: 12, output: "ok", truncated: false, ...overrides };
}

function data(overrides: Partial<ReviewData> = {}): ReviewData {
  return {
    repositoryPath: "/work/sample",
    baseRef: "main",
    baseCommit: "abc1234def",
    changedFiles: [{ path: "src/index.ts", status: "modified" }],
    validations: [validation()],
    summary: {
      files: { added: 0, modified: 1, deleted: 0, renamed: 0, copied: 0, untracked: 0, total: 1 },
      validations: { passed: 1, failed: 0, timed_out: 0, rejected: 0, total: 1 },
      ok: true,
    },
    ...overrides,
  };
}

describe("markdownReport", () => {
  it("lists changed files and validation output", () => {
    const report = markdownReport(data());
    expect(report).toContain("src/index.ts (modified)");
    expect(report).toContain("### npm test — passed (exit 0, 12 ms)");
    expect(report).toContain("ok");
  });

  it("shows the base commit, a summary line and rename sources", () => {
    const report = markdownReport(
      data({ changedFiles: [{ path: "b.ts", previousPath: "a.ts", status: "renamed" }] }),
    );
    expect(report).toContain("Base: main (abc1234)");
    expect(report).toContain("1 file (1 modified); validations: 1 passed");
    expect(report).toContain("b.ts (renamed from a.ts)");
  });

  it("keeps output containing backtick fences inside the code block", () => {
    const output = "before\n```\ninjected heading\n```\nafter";
    const report = markdownReport(data({ validations: [validation({ status: "failed", exitCode: 1, output })] }));
    const fourTicks = report.split("\n").filter((line) => line === "````");
    expect(fourTicks).toHaveLength(2);
    expect(report).toContain("failed (exit 1");
  });

  it("renders empty output as (no output)", () => {
    expect(markdownReport(data({ validations: [validation({ output: "" })] }))).toContain("(no output)");
  });
});

describe("fenceFor", () => {
  it("is one longer than the longest backtick run, minimum three", () => {
    expect(fenceFor("plain")).toBe("```");
    expect(fenceFor("a ````` b")).toBe("``````");
  });
});

describe("jsonReport", () => {
  it("round-trips the review data", () => {
    const parsed = JSON.parse(jsonReport(data()));
    expect(parsed.summary.files.total).toBe(1);
    expect(parsed.changedFiles[0].path).toBe("src/index.ts");
    expect(parsed.summary.ok).toBe(true);
  });
});
