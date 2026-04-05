import { readdir, lstat, rename, unlink } from "fs/promises";
import { open as fsOpen } from "fs/promises";
import { join } from "path";
import { parseRequest, type Request } from "./protocol";
import { serializeLine } from "./protocol";

const MAX_REQUEST_SIZE = 65536;
const VALID_ID_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;

export interface WatcherOptions {
  directory: string;
  pollIntervalMs: number;
  onRequest: (request: Request, responsePath: string) => Promise<void>;
  onError?: (error: unknown, filePath: string) => void;
}

/**
 * Read a file safely via file descriptor: open, stat, read, close.
 * Returns file contents or null if the file is not a regular file.
 */
async function readFileSafe(filePath: string): Promise<string | null> {
  const fd = await fsOpen(filePath, "r");
  try {
    const fdStat = await fd.stat();
    // Note: lstat (called before open) is the symlink defense; fstat cannot
    // detect symlinks because the fd points to the resolved target after open()
    if (!fdStat.isFile()) {
      return null;
    }
    return await fd.readFile({ encoding: "utf-8" });
  } finally {
    await fd.close();
  }
}

export function createWatcher(options: WatcherOptions): {
  start(): void;
  stop(): void;
} {
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  const inflight = new Set<string>();

  async function scanSubdirectories(): Promise<void> {
    if (stopped) return;
    let entries: string[];
    try {
      entries = await readdir(options.directory);
    } catch {
      return;
    }

    for (const entry of entries) {
      const subDirPath = join(options.directory, entry);
      let stat;
      try {
        stat = await lstat(subDirPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      await scanDirectory(subDirPath);
    }
  }

  async function scanDirectory(dirPath: string): Promise<void> {
    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      return;
    }

    // Recover orphaned .processing.json files (only if not currently inflight)
    for (const file of files) {
      if (file.endsWith(".processing.json")) {
        const id = file.replace(".processing.json", "");
        const processingFilePath = join(dirPath, file);
        const responsePath = join(dirPath, `${id}.response.jsonl`);
        const requestPath = join(dirPath, `${id}.request.json`);

        if (!inflight.has(requestPath)) {
          try {
            // Check if response already exists — request was completed
            await lstat(responsePath);
            // Response exists, just clean up the processing file
            await unlink(processingFilePath);
          } catch {
            // No response file — recover by renaming back to request
            try {
              await rename(processingFilePath, requestPath);
            } catch {
              // Already recovered or gone
            }
          }
        }
      }
      // Ignore .failed.json files — they are dead-lettered and should not be recovered
    }

    // Re-read after recovery
    try {
      files = await readdir(dirPath);
    } catch {
      return;
    }

    for (const file of files) {
      if (!file.endsWith(".request.json")) continue;

      const filePath = join(dirPath, file);

      if (stopped) return;
      if (inflight.has(filePath)) continue;
      inflight.add(filePath);

      processFile(filePath, dirPath, file).finally(() => {
        inflight.delete(filePath);
      });
    }
  }

  async function processFile(
    filePath: string,
    dirPath: string,
    fileName: string
  ): Promise<void> {
    // Validate filename-derived ID early so processingPath is available in outer catch
    const id = fileName.replace(".request.json", "");
    if (!VALID_ID_PATTERN.test(id)) {
      options.onError?.(
        new Error(`Invalid request ID in filename: ${id}`),
        filePath
      );
      return;
    }

    const processingPath = join(dirPath, `${id}.processing.json`);
    const responsePath = join(dirPath, `${id}.response.jsonl`);

    try {
      // Settle check: wait 50ms and verify file size is stable
      const stat1 = await lstat(filePath);
      await new Promise((r) => setTimeout(r, 50));
      const stat2 = await lstat(filePath);

      if (stat1.size !== stat2.size) return;

      // Defense-in-depth: reject symlinks via lstat
      if (stat2.isSymbolicLink()) return;

      // Reject oversized request files
      if (stat2.size > MAX_REQUEST_SIZE) {
        options.onError?.(
          new Error(`Request file too large: ${stat2.size} bytes`),
          filePath
        );
        return;
      }

      // TOCTOU-safe read using file descriptor
      const contents = await readFileSafe(filePath);
      if (contents === null) return;

      // Rename to .processing.json
      await rename(filePath, processingPath);

      // Parse and validate — errors here get an error response file
      let request: Request;
      try {
        request = parseRequest(JSON.parse(contents));
      } catch (parseError) {
        // Write an error response file for the caller
        try {
          const errorLine = serializeLine({
            type: "error",
            message: `Invalid request: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            ts: new Date().toISOString(),
          });
          const doneLine = serializeLine({
            type: "done",
            exit_code: null,
            completed_at: new Date().toISOString(),
          });
          await Bun.write(responsePath, errorLine + doneLine);
        } catch {
          // Best effort
        }
        // Clean up processing file
        try {
          await unlink(processingPath);
        } catch {
          // May already be gone
        }
        options.onError?.(parseError, filePath);
        return;
      }

      // Call handler
      await options.onRequest(request, responsePath);

      // Clean up processing file
      try {
        await unlink(processingPath);
      } catch {
        // May already be cleaned up
      }
    } catch (error) {
      // Handler or other error — move to failed state to prevent infinite re-processing
      try {
        const failedPath = join(dirPath, `${id}.failed.json`);
        await rename(processingPath, failedPath);
      } catch {
        // processingPath may not exist yet (error happened before rename)
        // try to clean up the original request file too
        try {
          await unlink(filePath);
        } catch {
          // Best effort
        }
      }
      options.onError?.(error, filePath);
    }
  }

  return {
    start() {
      // Do an immediate scan
      scanSubdirectories();
      timer = setInterval(scanSubdirectories, options.pollIntervalMs);
    },
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
