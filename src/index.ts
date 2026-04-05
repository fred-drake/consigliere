import { loadConfig } from "./config";
import { createLogger } from "./logger";
import { createWatcher } from "./watcher";
import { executeCommand } from "./executor";
import { serializeLine, type ResponseLine } from "./protocol";
import { mkdir, open } from "fs/promises";

async function main(): Promise<void> {
  const configPath = process.env.CONSIGLIERE_CONFIG_PATH;
  const config = await loadConfig(configPath);

  const logger = createLogger(config.logging.level, {
    write: (s: string) => process.stdout.write(s),
  });

  logger.info("Consigliere starting", {
    watchDirectory: config.watch.directory,
    commands: Object.keys(config.commands),
  });

  await mkdir(config.watch.directory, { recursive: true });

  const inflightCommands = new Set<string>();

  const watcher = createWatcher({
    directory: config.watch.directory,
    pollIntervalMs: config.watch.poll_interval_ms,
    onError: (error, filePath) => {
      logger.error("Watcher error", {
        error: String(error),
        filePath,
      });
    },
    onRequest: async (request, responsePath) => {
      inflightCommands.add(request.id);
      logger.info("Processing request", {
        id: request.id,
        command: request.command,
      });

      let fileHandle;
      try {
        // Open with O_CREAT | O_EXCL to prevent overwrites
        fileHandle = await open(responsePath, "wx");

        const responseWriter = async (line: ResponseLine): Promise<void> => {
          const serialized = serializeLine(line);
          await fileHandle!.write(serialized);
        };

        await executeCommand(request, config, responseWriter);
      } catch (err) {
        logger.error("Failed to process request", {
          id: request.id,
          error: String(err),
        });
        // Write error response so the caller doesn't hang
        if (fileHandle) {
          try {
            const errorLine = serializeLine({
              type: "error",
              message: `Internal error: ${String(err)}`,
              ts: new Date().toISOString(),
            });
            const doneLine = serializeLine({
              type: "done",
              exit_code: null,
              completed_at: new Date().toISOString(),
            });
            await fileHandle.write(errorLine + doneLine);
          } catch {
            // Best effort
          }
        }
      } finally {
        if (fileHandle) {
          await fileHandle.close();
        }
        inflightCommands.delete(request.id);
        logger.info("Request completed", { id: request.id });
      }
    },
  });

  async function shutdown(signal: string): Promise<void> {
    logger.info("Shutting down", { signal });
    watcher.stop();

    // Wait for in-flight commands to finish (max 30s)
    const maxWait = 30000;
    const start = Date.now();
    while (inflightCommands.size > 0 && Date.now() - start < maxWait) {
      logger.info("Waiting for in-flight commands", {
        count: inflightCommands.size,
      });
      await new Promise((r) => setTimeout(r, 500));
    }

    if (inflightCommands.size > 0) {
      logger.warn("Exiting with in-flight commands", {
        count: inflightCommands.size,
      });
    }

    logger.info("Consigliere stopped");
    process.exitCode = 0;
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  watcher.start();
  logger.info("Consigliere ready");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
