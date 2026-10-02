import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.js";
import { InspectorError } from "../src/types.js";

describe("parseArgs", () => {
  it("parses the documented happy path", () => {
    const args = parseArgs(["review", "--repo", "./x", "--base-ref", "develop", "--format", "json", "--output", "-"]);
    expect(args).toMatchObject({ command: "review", repositoryPath: "./x", baseRef: "develop", format: "json", output: "-" });
  });

  it("keeps a repository path that contains spaces", () => {
    expect(parseArgs(["review", "--repo", "/tmp/a b/c"]).repositoryPath).toBe("/tmp/a b/c");
  });

  it("collects repeated --validate commands in order", () => {
    expect(parseArgs(["review", "--repo", ".", "--validate", "npm test", "--validate", "npm run lint"]).validations).toEqual([
      "npm test",
      "npm run lint",
    ]);
  });

  it("rejects an unknown format and unknown flags", () => {
    expect(() => parseArgs(["review", "--repo", ".", "--format", "xml"])).toThrow(InspectorError);
    expect(() => parseArgs(["review", "--repo", ".", "--bogus"])).toThrow(InspectorError);
  });

  it("rejects a non-numeric timeout", () => {
    expect(() => parseArgs(["review", "--repo", ".", "--timeout", "soon"])).toThrow(/positive number/);
  });

  it("defaults to markdown and review-report.md, and recognises --help", () => {
    const args = parseArgs(["--help"]);
    expect(args.help).toBe(true);
    expect(args.format).toBe("markdown");
    expect(args.output).toBe("review-report.md");
  });
});
