# Consigliere

<p align="center">
  <img src="images/logo.png" alt="Consigliere logo" width="400">
</p>

A file-based command execution bridge for sandboxed AI agents. You drop a JSON request file in a shared directory, consigliere validates it against an allowlist, runs the command (never through a shell), and streams NDJSON output back.

## Why this exists

Claude Cowork runs in a sandbox with no network or command access. Good. But sometimes you need it to create a calendar event or send an email via `gws`. Consigliere is the workaround: a Docker container that shares a directory with Cowork, reads request files, and runs only the commands you've pre-approved.

If a command isn't in the config, it doesn't run. Period.

## How it works

1. Cowork writes `shared/gws/abc123.request.json`
2. Consigliere renames it to `.processing.json` and validates the command
3. If allowed, the command runs and output streams into `abc123.response.jsonl`
4. Cowork reads the response and deletes the file

Malformed or rejected requests get an error response so the caller doesn't hang forever. Requests that keep failing get moved to `.failed.json` as a dead letter.

### Request format

```json
{
  "version": 1,
  "id": "abc123",
  "command": "gws",
  "args": ["calendar", "list"],
  "timeout_ms": 30000,
  "created_at": "2026-04-05T12:52:26Z"
}
```

### Response format (NDJSON)

```jsonl
{"type":"started","id":"abc123","started_at":"2026-04-05T12:52:26Z"}
{"type":"stdout","data":"Meeting at 3pm\n","ts":"2026-04-05T12:52:27Z"}
{"type":"done","exit_code":0,"completed_at":"2026-04-05T12:52:28Z"}
```

Output streams as it happens. No waiting for the command to finish.

## Setup

You need [Bun](https://bun.sh/) (or use the Nix flake: `nix develop`) and Docker for production.

```bash
bun install
bun test
bun start
```

### Configuration

Edit `config/consigliere.toml` to define what's allowed:

```toml
[watch]
directory = "/shared/consigliere"
poll_interval_ms = 500

[execution]
default_timeout_ms = 30000
max_timeout_ms = 120000
max_output_bytes = 1048576

[commands.gws]
path = "/usr/local/bin/gws"
allowed_subcommands = ["calendar", "gmail", "drive"]
denied_flags = ["--debug", "--verbose", "--token", "--credentials"]

[logging]
level = "info"
```

All config values can be overridden with environment variables: `CONSIGLIERE_WATCH_DIRECTORY=/alt/path`, `CONSIGLIERE_EXECUTION_DEFAULT_TIMEOUT_MS=60000`, etc.

An empty commands section means everything is rejected. Fail closed by design.

### Docker

```bash
docker compose up
```

The container runs read-only with all capabilities dropped, a non-root user, and PID/memory limits. Config is mounted read-only; the shared directory is the only writable mount.

## Security

This is a deliberate hole in a sandbox, so the rules are tight:

- Commands are spawned with `Bun.spawn` and an argv array. No shell, ever. Shell metacharacters in arguments are rejected as an extra layer of protection.
- Every command needs an explicit entry in the config with an absolute path. You can restrict subcommands and deny specific flags.
- Child processes get a minimal environment: just `PATH`, `HOME`, and `LANG`.
- Commands that exceed their timeout get SIGTERM, then SIGKILL five seconds later.
- Output that exceeds `max_output_bytes` gets truncated and the process is killed.
- Request files are checked with `lstat` to reject symlinks, then read through a verified file descriptor.
- The rename-to-claim file lifecycle prevents double execution.

## License

MIT
