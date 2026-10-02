# Repository Inspector

A small TypeScript tool that lists what changed in a Git repository against a
base branch, runs validation commands, and produces a Markdown or JSON report.
It has two interfaces that share one core: a command line for developers and
CI, and an MCP server for AI coding agents.

## Interface decision: hybrid, one core

`src/core.ts` is the only review pipeline. The CLI and the MCP server are thin
adapters that translate their input into a `ReviewRequest` and apply policy.
A bug fixed in the core is fixed for both callers; a test of the core covers
both. The two adapters differ only in **who is trusted to do what**:

| | CLI | MCP |
|---|---|---|
| Caller | a developer or CI job with a shell | an AI model |
| Validation commands | anything the caller passes | only exact matches from `INSPECTOR_ALLOWED_COMMANDS` (unset = none) |
| Repository path | anywhere | inside `INSPECTOR_ALLOWED_ROOT` (default: server cwd) |
| Output | full report to a file or stdout, exit code | report capped at 50,000 characters plus a structured summary |
| Errors | message on stderr, exit code 2 | result with `isError: true` and a stable code |

The person who starts the MCP server is trusted; the model is not. The model
may ask for a review, but the operator decides which commands can run and
where. See `SUBMISSION.md` for the full reasoning and the evidence that would
change this decision.

## Setup

```bash
npm ci
npm run typecheck
npm run build
npm test
```

## CLI

```bash
npm run inspector -- review --repo ./path/to/repo
npm run inspector -- review --repo ./path/to/repo --validate "npm test" --validate "npm run lint"
npm run inspector -- review --repo ./path/to/repo --format json --output -
npm run inspector -- review --repo ./path/to/repo --base-ref develop --timeout 60000
```

The report is written to `review-report.md` unless `--output` says otherwise;
`--output -` prints it to stdout and keeps the summary on stderr.

Exit codes: `0` every validation passed, `1` a validation failed, timed out or
was rejected, `2` usage error or the repository could not be inspected.

Validation commands run through a shell, one after another, each with a
timeout (default 120 s) and an output cap (default 64 KiB). A failing command
is reported as failed; it never aborts the review.

## MCP

```bash
INSPECTOR_ALLOWED_COMMANDS=$'npm test\nnpm run typecheck' \
INSPECTOR_ALLOWED_ROOT=/path/to/projects \
npm run mcp-server
```

The stdio server exposes one tool, `review_repository`, with this input:

| field | type | notes |
|---|---|---|
| `repo_path` | string, required | must be inside `INSPECTOR_ALLOWED_ROOT` |
| `base_ref` | string | defaults to `origin/HEAD`, then `main`, then `master` |
| `validation_commands` | string[] (max 10) | each must exactly match an allowed command; others are reported as `rejected` without running |
| `format` | `markdown` or `json` | default `markdown` |
| `max_output_bytes` | integer | clamped to `INSPECTOR_MAX_OUTPUT_BYTES` (default 65536) |

If `INSPECTOR_ALLOWED_COMMANDS` is not set, every validation command is
rejected. That is deliberate: the safe state should not depend on someone
remembering to lock the server down.

## Project layout

```text
src/core.ts         the one review pipeline (git + validation + render)
src/cli.ts          command-line adapter
src/mcp-server.ts   MCP adapter and its trust policy
src/git.ts          Git inspection
src/validation.ts   bounded command execution
src/report.ts       Markdown and JSON rendering
src/types.ts        shared types and InspectorError
test/               vitest suites for every module and both adapters
```
