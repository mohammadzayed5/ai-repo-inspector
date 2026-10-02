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

Found during design review, before coding: CI runs `build` then `test`, and vitest only excludes `node_modules` and `.git`, so the compiled `dist/test/*.js` would run every test a second time; a `base_ref` like `--output=/tmp/x` would be read by git as an option; a repository's own `.git/config` (`core.fsmonitor`) can run code when git is invoked; `execFileSync`'s 1 MB default buffer throws on large diffs.

## What did you choose to implement or fix?

One commit per step, security and contract first so a cutoff would still ship them:

1. `package.json`: `bin` points at the file the build produces; `vitest run --dir test` keeps `dist/` out of the test run.
2. `types.ts`: one `ReviewData` shape both adapters build and render; real validation statuses (`passed`, `failed`, `timed_out`, `rejected`); `InspectorError` with a stable code.
3. `validation.ts`: never rejects. Non-zero exit is `failed` with the code; a timeout kills the whole process group and reports `timed_out`; output is capped with a marker; an exact-match allowlist reports `rejected` without spawning. Sequential on purpose.
4. `report.ts` + `core.ts`: build the review as data, then render Markdown or JSON through one function. Fences grow past the longest backtick run in the output. Summary line, base commit, rename sources, exit codes and durations.
5. `mcp-server.ts`: `registerTool` with a typed Zod schema using the advertised snake_case names (the contract was right, the code was wrong); fail-closed allowlist and allowed-root from env; errors returned as results with codes; report capped at 50,000 characters plus a structured summary; `createServer` and `handleReview` exported so tests can call them without stdio.
6. `git.ts`: base ref resolution (explicit and verified, then `origin/HEAD`, `main`, `master`); refs starting with `-` refused; one `diff --name-status -z -M` from the merge base to the work tree so committed, staged and unstaged changes appear once; renames and copies carry both paths; untracked files via `ls-files`; `core.fsmonitor=false` on every call; 64 MB buffer.
7. `cli.ts`: `node:util` `parseArgs` in strict mode; `--output`, `--format`, `--timeout`, `--help`; exit codes 0/1/2; summary on stderr so `--output -` keeps stdout clean.
8. Tests: 33 across 5 files, including a temp-repo git fixture and a protocol-level MCP test over `InMemoryTransport` that sends `repoPath` and expects an error, then `repo_path` and expects a report. That is the regression test for the original bug.

## What did you intentionally not do?

- No authentication or multi-user story for MCP beyond env configuration; stdio on a developer machine is the assumed deployment.
- No parallel validations (ordering and port conflicts matter more than speed for a review tool).
- No streaming or progress notifications; validations are bounded by `count × timeout` instead.
- No HTTP transport, no config file, no `outputSchema` (declaring one makes the SDK reject any result that drifts from it; worth doing once the shape settles).
- No sandboxing of validation commands and no environment-variable stripping; the allowlist is the control.
- No separate build tsconfig; `bin` was pointed at the real output instead.

## Interface decision

- Decision: **hybrid, one shared core.** CLI-first for developers and CI; MCP as a locked-down adapter.
- Primary user and execution environment: a developer or CI job on a local checkout, running the CLI. Secondary: an AI coding agent on the same machine calling the MCP server over stdio.
- Trust boundary and allowed capabilities: the CLI user already has a shell, so letting them run `npm test` adds no risk. The MCP caller is a model, so the person who started the server decides which exact commands may run (`INSPECTOR_ALLOWED_COMMANDS`, unset means none) and where repositories may live (`INSPECTOR_ALLOWED_ROOT`, checked by real path). The model chooses within those limits. Repository code is trusted exactly as far as the operator's allowlist trusts it.
- Reliability, discoverability, latency/context, and output tradeoffs: one pipeline means a bug fixed once is fixed for both. The MCP tool self-describes through its schema and annotations; the CLI has `--help` and exit codes. Validations run one at a time with a timeout, so latency is bounded but adds up. Output per command is capped, the MCP report is capped, and JSON is available for machines. The CLI writes a full report to a file; MCP returns a capped report plus a small structured summary that fits an agent's context.
- How supported interfaces remain consistent: every behaviour is a field on `ReviewRequest`; adapters only translate input and apply policy. `reviewRepository` and `renderReport` run for both. Tests cover the core, the CLI parser, the MCP handler and the MCP contract over a real client.
- Evidence that would change this decision: if agents in practice never request validations, drop that capability from MCP and make it read-only (MCP-first). If nobody calls it over MCP, delete the adapter (CLI-first). If remote or multi-user access is needed, the HTTP transport plus authentication becomes the first job.

## How did you use an AI coding agent?

I worked with Claude Code (Claude Fable 5.1) throughout. It read the starter and listed the defects; I confirmed each one against the source before accepting it. I chose the interface decision after being walked through all three options with their tradeoffs, chose fail-closed for the MCP allowlist, chose `node:util` `parseArgs` over a hand-written parser, and chose to include the protocol-level MCP test. The agent drafted the code and tests step by step; I reviewed each diff and the test output before each commit.

## Where did you check, correct, or reject an AI suggestion? (required)

1. **Rejected:** replacing the shell with `execFile` by splitting the command string on spaces. It would have broken quoting, `&&` and env prefixes like `A=1 make check`, reintroduced the exact split-on-spaces bug being removed from the CLI, and added no real safety, since `node -e "..."` is arbitrary code with no shell involved. The control that matters is *which* commands may run, so the shell stayed and the allowlist became the boundary.
2. **Corrected:** the first design assumed `vitest run` only scanned `test/`. Checking vitest's defaults showed it scans everything except `node_modules` and `.git`, so after `npm run build` the compiled tests under `dist/` would run twice. The test script became `vitest run --dir test`.
3. **Corrected:** the first draft of the allowlist used a default list of safe-looking commands when the env var was unset. I changed it to fail closed: an unset variable allows nothing, because the safe state should not depend on someone remembering to configure it.

## Commands used to verify the result, with outcomes

- `npm ci` then `npm run typecheck`: clean.
- `npm run build`: clean; `node dist/src/cli.js --help` prints usage.
- `npm test`: 5 files, 33 tests, all passing, each counted once.
- `npm run inspector -- review --repo . --validate 'node -e "process.exit(1)"' --output /tmp/rr.md`: exit code 1, summary "validations: 0 passed, 1 not passed", report heading `failed (exit 1, ...)`. A first attempt without the inner quotes reported `failed (exit 2)`: the shell rejected `(1)` as syntax, and the report said so instead of hiding it, which is the behaviour the validation change was meant to produce.
- `npm run inspector -- review --repo . --format xml`: prints `--format must be markdown or json, got xml` and usage, exit code 2.
- `npm run inspector -- review --repo . --format json --output -`: JSON on stdout, summary on stderr, base resolved to `origin/main`.
- MCP: `test/mcp-server.test.ts` calls the tool over `InMemoryTransport` with `repoPath` (error) and `repo_path` (report), checks path escape (`PATH_NOT_ALLOWED`), the allowlist (`rejected`), a bad base ref (`BAD_BASE_REF` as a result) and `loadConfig` failing closed.

## A blocker you hit and how you approached it

`npm install` rewrote `package-lock.json` because my npm version differs from the one that produced the lock. Rather than commit an unrelated lockfile churn, I reverted it and used `npm ci`, which installs from the lock without touching it.

A smaller one: `tsc` does not set the executable bit on `dist/src/cli.js`. npm sets it when the package is installed or linked, and `node dist/src/cli.js` works regardless, so I left the build alone and verified the binary through node.

## Known limitations and the next three things you would do

Limitations: validations inherit the server's full environment; the allowlist is exact-match only, so an operator who wants `npm test -- --run` must list it verbatim; there is no `outputSchema`, so clients cannot validate `structuredContent`; Windows process-group killing is best-effort.

Next three: (1) a `tsconfig.build.json` with `rootDir: "src"` so tests never land in `dist` and `bin` can be `dist/cli.js`; (2) `outputSchema` plus MCP progress notifications for long validations; (3) a sandboxed runner (container or stripped environment) so the allowlist is not the only control.

## Approximate focused-work time

- Start: 2026-10-02 09:46 PDT (clone, npm ci, baseline typecheck and test)
- Finish: 2026-10-02 10:16 PDT
