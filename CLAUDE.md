# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun test                          # Run all tests
bun test test/executor.test.ts    # Run a single test file
bun x tsc --noEmit                # Type check (no emit)
bun start                         # Run the application
bun install                       # Install dependencies
```

Note: The TS language server may show "Cannot find module" errors for `../src/*` imports in tests. These are false positives — `bun x tsc --noEmit` is the source of truth for type checking.

## Architecture

Consigliere is a command execution bridge that runs in Docker. It watches a shared directory for JSON request files written by Claude Cowork (which runs in a tight sandbox), validates commands against an allowlist, executes them without a shell, and streams NDJSON response output back.

### Module Dependency Flow

```
index.ts → config.ts, logger.ts, watcher.ts, executor.ts, protocol.ts
watcher.ts → protocol.ts
executor.ts → protocol.ts, config.ts
```

No circular dependencies. Each module has a single responsibility.

### File Protocol

**Request lifecycle:** Writer creates `{id}.request.json` → consigliere renames to `{id}.processing.json` (claims it) → executes → writes `{id}.response.jsonl` → deletes processing file. Failed requests get moved to `{id}.failed.json` (dead-letter queue).

**Request:** JSON with Zod `.strict()` validation — `{ version, id, command, args, timeout_ms?, created_at }`.

**Response:** NDJSON (`.jsonl`) with streaming line types: `started`, `stdout`, `stderr`, `error`, `done`. The `done` line is always the terminal event — every code path must emit it.

### Security Model

This is an intentional hole in a sandbox. Key constraints:

- **No shell execution.** `Bun.spawn` with argv array only — never a command string.
- **Command allowlist** with per-command absolute paths, optional subcommand allowlists, and denied flags (matched with `--flag=value` prefix too).
- **Shell metacharacter rejection** in all args as defense-in-depth.
- **Sanitized child environment** — only PATH, HOME, LANG passed to spawned processes.
- **Symlink rejection** via `lstat` before open, plus `fstat` file-type check on the opened fd.
- **64KB max request file size**, configurable output byte cap with process kill on exceed.
- **Timeout** with SIGTERM → SIGKILL escalation (5s grace).

### Configuration

TOML config at `config/consigliere.toml`. Environment variable overrides follow `CONSIGLIERE_SECTION_KEY` pattern (e.g., `CONSIGLIERE_WATCH_DIRECTORY`). Numeric keys use an explicit `NUMERIC_KEYS` set — don't add string keys there.

### Container

Read-only filesystem, all capabilities dropped, non-root user, PID/memory limits. Config mounted as read-only volume. The `shared/` directory is the IPC mount point.

## Testing

Tests use real process execution via shell script fixtures in `test/fixtures/`. The watcher tests use temp directories (`mkdtemp`) and a `waitFor` polling helper for async assertions. Negative tests (asserting something didn't happen) use timeouts — these are set to 1000ms to reduce flakiness.

The `responseWriter` type is `(line: ResponseLine) => void | Promise<void>`. When collecting lines in tests, use `(line: ResponseLine) => { lines.push(line); }` (block body) not `(line) => lines.push(line)` (which returns `number` and fails `tsc`).
