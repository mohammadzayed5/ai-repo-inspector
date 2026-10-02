# Submission

## What did you investigate first, and why?

I read every file in `src/` before running anything, because the README says the MCP input contract needs checking and that the starter only handles a narrow happy path. Then I ran `npm ci`, `npm run typecheck` and `npm test` to get a baseline: both pass, with 1 test. Findings, in the order I planned to fix them:

1. `mcp-server.ts` declares `repo_path` in its schema but reads `input.repoPath`, so the MCP tool always runs git in the server's own directory. The advertised contract is broken.
2. `validation.ts` runs whatever command the caller passes through a shell, with no timeout and no output cap. Over MCP the caller is an AI client, so this is an arbitrary command execution path.
3. A non-zero exit rejects the promise, so one failing check aborts the whole review. The `"failed"` status in `types.ts` is never produced.
4. `cli.ts` splits `--repo` on spaces and ignores `--format`. The report always goes to `review-report.md` in the current directory.
5. `git.ts` assumes a `main` branch, mis-parses renames (both paths end up in one string), never reports untracked files although the type allows it, and throws raw errors on non-repos.
6. `report.ts` puts raw output inside a fixed triple-backtick fence, so output containing backticks corrupts the report.
7. One test covers only `report.ts`. `package.json` points `bin` at `dist/cli.js`, but with `rootDir: "."` the build emits `dist/src/cli.js`.

## What did you choose to implement or fix?

## What did you intentionally not do?

## Interface decision

- Decision: CLI-first / MCP-first / hybrid
- Primary user and execution environment:
- Trust boundary and allowed capabilities:
- Reliability, discoverability, latency/context, and output tradeoffs:
- How supported interfaces remain consistent:
- Evidence that would change this decision:

## How did you use an AI coding agent?

## Where did you check, correct, or reject an AI suggestion? (required)

## Commands used to verify the result, with outcomes

## A blocker you hit and how you approached it

## Known limitations and the next three things you would do

## Approximate focused-work time

- Start: 2026-10-02 09:46 PDT (clone, npm ci, baseline typecheck and test)
- Finish: