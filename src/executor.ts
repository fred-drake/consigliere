import type { Request, ResponseLine } from "./protocol";
import type { Config } from "./config";

const SHELL_METACHARACTERS = /[;|&$`(){}<>\n\r\0]/;

export function validateCommand(
  request: Request,
  config: Config
): string | null {
  const commandConfig = config.commands[request.command];
  if (!commandConfig) {
    return `Command "${request.command}" is not allowed`;
  }

  // Check stale request
  const createdAt = new Date(request.created_at).getTime();
  const now = Date.now();
  if (now - createdAt > config.watch.stale_request_timeout_ms) {
    return `Request is stale (created at ${request.created_at})`;
  }

  // Check shell metacharacters in all args
  for (const arg of request.args) {
    if (SHELL_METACHARACTERS.test(arg)) {
      return `Argument contains shell metacharacters: "${arg}"`;
    }
  }

  // Check subcommands
  if (commandConfig.allowed_subcommands && request.args.length > 0) {
    const subcommand = request.args[0];
    if (!commandConfig.allowed_subcommands.includes(subcommand)) {
      return `Subcommand "${subcommand}" is not allowed for "${request.command}"`;
    }
  }

  // Check denied flags
  if (commandConfig.denied_flags) {
    for (const arg of request.args) {
      for (const denied of commandConfig.denied_flags) {
        if (arg === denied || arg.startsWith(denied + "=")) {
          return `Flag "${arg}" is denied for "${request.command}"`;
        }
      }
    }
  }

  return null;
}

export async function executeCommand(
  request: Request,
  config: Config,
  responseWriter: (line: ResponseLine) => void | Promise<void>
): Promise<void> {
  // Validate first
  const validationError = validateCommand(request, config);
  if (validationError) {
    await responseWriter({
      type: "error",
      message: validationError,
      ts: new Date().toISOString(),
    });
    await responseWriter({
      type: "done",
      exit_code: null,
      completed_at: new Date().toISOString(),
    });
    return;
  }

  const commandConfig = config.commands[request.command];
  const timeoutMs = Math.min(
    request.timeout_ms ?? config.execution.default_timeout_ms,
    config.execution.max_timeout_ms
  );

  await responseWriter({
    type: "started",
    id: request.id,
    started_at: new Date().toISOString(),
  });

  const sanitizedEnv: Record<string, string> = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp",
    LANG: "en_US.UTF-8",
  };

  const proc = Bun.spawn([commandConfig.path, ...request.args], {
    env: sanitizedEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  let totalOutputBytes = 0;
  let outputCapped = false;

  const readStream = async (
    stream: ReadableStream<Uint8Array> | null,
    type: "stdout" | "stderr"
  ) => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (outputCapped) continue;

        const text = decoder.decode(value, { stream: true });
        totalOutputBytes += value.byteLength;

        if (totalOutputBytes > config.execution.max_output_bytes) {
          outputCapped = true;
          await responseWriter({
            type: "error",
            message: "Output exceeded max_output_bytes limit",
            ts: new Date().toISOString(),
          });
          try {
            proc.kill("SIGTERM");
          } catch {
            // Process may have already exited
          }
          continue;
        }

        await responseWriter({
          type,
          data: text,
          ts: new Date().toISOString(),
        });
      }
    } finally {
      reader.releaseLock();
    }
  };

  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutId = setTimeout(async () => {
      timedOut = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // Process may have already exited
      }
      // Give 5s for graceful shutdown, then SIGKILL
      const sigkillTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Process may have already exited
        }
      }, 5000);
      // Clear SIGKILL timer when process exits promptly after SIGTERM
      proc.exited.then(() => clearTimeout(sigkillTimer));
      resolve();
    }, timeoutMs);
  });

  const executionPromise = (async () => {
    await Promise.all([
      readStream(proc.stdout as ReadableStream<Uint8Array> | null, "stdout"),
      readStream(proc.stderr as ReadableStream<Uint8Array> | null, "stderr"),
    ]);
    await proc.exited;
  })();

  await Promise.race([executionPromise, timeoutPromise]);

  if (!timedOut) {
    clearTimeout(timeoutId!);
  }

  if (timedOut) {
    // Wait briefly for process to actually exit
    await Promise.race([
      proc.exited,
      new Promise((r) => setTimeout(r, 6000)),
    ]);
    await responseWriter({
      type: "error",
      message: `Command timed out after ${timeoutMs}ms`,
      ts: new Date().toISOString(),
    });
    await responseWriter({
      type: "done",
      exit_code: null,
      completed_at: new Date().toISOString(),
    });
  } else {
    await responseWriter({
      type: "done",
      exit_code: proc.exitCode ?? null,
      completed_at: new Date().toISOString(),
    });
  }
}
