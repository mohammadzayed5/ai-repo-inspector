import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, handleReview, loadConfig, type ServerConfig } from "../src/mcp-server.js";

let root: string;
let repo: string;
let config: ServerConfig;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "inspector-mcp-")));
  repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  const g = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo });
  g("add", ".");
  g("commit", "-q", "-m", "base");
  writeFileSync(join(repo, "b.txt"), "b\n");
  config = { allowedCommands: ['node -e "process.exit(0)"'], allowedRoot: root, maxOutputBytes: 1024 };
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("handleReview", () => {
  it("reviews a repository inside the allowed root", async () => {
    const result = await handleReview({ repo_path: repo }, config);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("b.txt (untracked)");
    expect(result.structuredContent?.summary.files.total).toBe(1);
  });

  it("refuses a repository outside the allowed root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "inspector-outside-"));
    try {
      const result = await handleReview({ repo_path: outside }, config);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/^PATH_NOT_ALLOWED/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects commands that are not on the allowed list and runs the ones that are", async () => {
    const result = await handleReview(
      { repo_path: repo, validation_commands: ['node -e "process.exit(0)"', "rm -rf /"] },
      config,
    );
    expect(result.structuredContent?.validations.map((v) => v.status)).toEqual(["passed", "rejected"]);
  });

  it("returns BAD_BASE_REF as a result instead of throwing", async () => {
    const result = await handleReview({ repo_path: repo, base_ref: "nope" }, config);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^BAD_BASE_REF/);
  });
});

describe("loadConfig", () => {
  it("fails closed: no env means no allowed commands", () => {
    expect(loadConfig({}).allowedCommands).toEqual([]);
  });
  it("reads newline-separated commands", () => {
    expect(loadConfig({ INSPECTOR_ALLOWED_COMMANDS: "npm test\n npm run lint \n" }).allowedCommands).toEqual([
      "npm test",
      "npm run lint",
    ]);
  });
});

describe("review_repository over the protocol", () => {
  it("accepts the advertised repo_path field and rejects the misspelled one", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(config);
    const client = new Client({ name: "test", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const ok = await client.callTool({ name: "review_repository", arguments: { repo_path: repo, format: "json" } });
      expect(ok.isError).toBeFalsy();
      const parsed = JSON.parse((ok.content as Array<{ text: string }>)[0].text);
      expect(parsed.summary.files.untracked).toBe(1);

      const bad = await client.callTool({ name: "review_repository", arguments: { repoPath: repo } });
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
