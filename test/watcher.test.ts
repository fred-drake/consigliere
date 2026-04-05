import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createWatcher } from "../src/watcher";
import type { Request } from "../src/protocol";
import { mkdtemp, rm, mkdir, writeFile, symlink, readdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "consigliere-test-"));
}

function makeValidRequest(): object {
  return {
    version: 1,
    id: "test-001",
    command: "echo",
    args: ["hello"],
    created_at: new Date().toISOString(),
  };
}

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timed out");
}

describe("watcher", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("detects new .request.json file and calls onRequest", async () => {
    // Create a command namespace subdirectory
    const nsDir = join(tempDir, "echo");
    await mkdir(nsDir, { recursive: true });

    let receivedRequest: Request | null = null;
    let receivedResponsePath = "";

    const watcher = createWatcher({
      directory: tempDir,
      pollIntervalMs: 100,
      onRequest: async (request: Request, responsePath: string) => {
        receivedRequest = request;
        receivedResponsePath = responsePath;
      },
    });

    watcher.start();

    // Write a request file inside the namespace subdirectory
    const requestPath = join(nsDir, "test-001.request.json");
    await writeFile(requestPath, JSON.stringify(makeValidRequest()));

    await waitFor(async () => receivedRequest !== null);

    expect(receivedRequest).not.toBeNull();
    expect(receivedRequest!.id).toBe("test-001");
    expect(receivedResponsePath).toContain("test-001.response.jsonl");

    watcher.stop();
  });

  test("ignores non-.request.json files", async () => {
    const nsDir = join(tempDir, "echo");
    await mkdir(nsDir, { recursive: true });

    let called = false;
    const watcher = createWatcher({
      directory: tempDir,
      pollIntervalMs: 100,
      onRequest: async () => {
        called = true;
      },
    });

    watcher.start();

    await writeFile(join(nsDir, "test.txt"), "hello");
    await writeFile(join(nsDir, "test.response.jsonl"), "hello");

    await new Promise((r) => setTimeout(r, 1000));
    expect(called).toBe(false);

    watcher.stop();
  });

  test("rejects symlinks", async () => {
    const nsDir = join(tempDir, "echo");
    await mkdir(nsDir, { recursive: true });

    let called = false;
    const watcher = createWatcher({
      directory: tempDir,
      pollIntervalMs: 100,
      onRequest: async () => {
        called = true;
      },
    });

    watcher.start();

    // Create a real file and a symlink to it
    const realFile = join(tempDir, "real.json");
    await writeFile(realFile, JSON.stringify(makeValidRequest()));
    await symlink(realFile, join(nsDir, "test-sym.request.json"));

    await new Promise((r) => setTimeout(r, 1000));
    expect(called).toBe(false);

    watcher.stop();
  });

  test("renames file to .processing.json during execution", async () => {
    const nsDir = join(tempDir, "echo");
    await mkdir(nsDir, { recursive: true });

    let processingExists = false;

    const watcher = createWatcher({
      directory: tempDir,
      pollIntervalMs: 100,
      onRequest: async (_request: Request, _responsePath: string) => {
        // Check if processing file exists while we're executing
        const files = await readdir(nsDir);
        processingExists = files.some((f) => f.endsWith(".processing.json"));
      },
    });

    watcher.start();

    await writeFile(
      join(nsDir, "test-001.request.json"),
      JSON.stringify(makeValidRequest())
    );

    await waitFor(async () => processingExists);
    expect(processingExists).toBe(true);

    watcher.stop();
  });

  test("deletes .processing.json after completion", async () => {
    const nsDir = join(tempDir, "echo");
    await mkdir(nsDir, { recursive: true });

    let done = false;

    const watcher = createWatcher({
      directory: tempDir,
      pollIntervalMs: 100,
      onRequest: async () => {
        done = true;
      },
    });

    watcher.start();

    await writeFile(
      join(nsDir, "test-001.request.json"),
      JSON.stringify(makeValidRequest())
    );

    await waitFor(async () => done);
    // Give a moment for cleanup
    await new Promise((r) => setTimeout(r, 200));

    const files = await readdir(nsDir);
    const processingFiles = files.filter((f) =>
      f.endsWith(".processing.json")
    );
    expect(processingFiles).toHaveLength(0);

    watcher.stop();
  });

  test("creates .response.jsonl path correctly", async () => {
    const nsDir = join(tempDir, "echo");
    await mkdir(nsDir, { recursive: true });

    let responsePath = "";

    const watcher = createWatcher({
      directory: tempDir,
      pollIntervalMs: 100,
      onRequest: async (_request: Request, rp: string) => {
        responsePath = rp;
      },
    });

    watcher.start();

    await writeFile(
      join(nsDir, "test-001.request.json"),
      JSON.stringify(makeValidRequest())
    );

    await waitFor(async () => responsePath !== "");
    expect(responsePath).toBe(join(nsDir, "test-001.response.jsonl"));

    watcher.stop();
  });

  test("does not double-process same file", async () => {
    const nsDir = join(tempDir, "echo");
    await mkdir(nsDir, { recursive: true });

    let callCount = 0;

    const watcher = createWatcher({
      directory: tempDir,
      pollIntervalMs: 100,
      onRequest: async () => {
        callCount++;
        // Slow handler to allow multiple poll cycles
        await new Promise((r) => setTimeout(r, 300));
      },
    });

    watcher.start();

    await writeFile(
      join(nsDir, "test-001.request.json"),
      JSON.stringify(makeValidRequest())
    );

    // Wait enough for multiple poll cycles
    await new Promise((r) => setTimeout(r, 800));
    expect(callCount).toBe(1);

    watcher.stop();
  });

  test("handles startup with pre-existing request files", async () => {
    const nsDir = join(tempDir, "echo");
    await mkdir(nsDir, { recursive: true });

    // Write request file BEFORE starting watcher
    await writeFile(
      join(nsDir, "pre-existing.request.json"),
      JSON.stringify({
        ...makeValidRequest(),
        id: "pre-existing",
      })
    );

    let receivedRequest: Request | null = null;

    const watcher = createWatcher({
      directory: tempDir,
      pollIntervalMs: 100,
      onRequest: async (request: Request) => {
        receivedRequest = request;
      },
    });

    watcher.start();

    await waitFor(async () => receivedRequest !== null);
    expect(receivedRequest!.id).toBe("pre-existing");

    watcher.stop();
  });

  test("stop() ceases watching", async () => {
    const nsDir = join(tempDir, "echo");
    await mkdir(nsDir, { recursive: true });

    let callCount = 0;

    const watcher = createWatcher({
      directory: tempDir,
      pollIntervalMs: 100,
      onRequest: async () => {
        callCount++;
      },
    });

    watcher.start();
    watcher.stop();

    // Write file after stopping
    await writeFile(
      join(nsDir, "test-001.request.json"),
      JSON.stringify(makeValidRequest())
    );

    await new Promise((r) => setTimeout(r, 1000));
    expect(callCount).toBe(0);
  });

  test("ignores files at root level", async () => {
    let called = false;

    const watcher = createWatcher({
      directory: tempDir,
      pollIntervalMs: 100,
      onRequest: async () => {
        called = true;
      },
    });

    watcher.start();

    // Write request file at root level (no namespace subdir)
    await writeFile(
      join(tempDir, "test-001.request.json"),
      JSON.stringify(makeValidRequest())
    );

    await new Promise((r) => setTimeout(r, 1000));
    expect(called).toBe(false);

    watcher.stop();
  });

  test("invalid JSON in request file calls onError", async () => {
    const nsDir = join(tempDir, "echo");
    await mkdir(nsDir, { recursive: true });

    let errorCaught: unknown = null;

    const watcher = createWatcher({
      directory: tempDir,
      pollIntervalMs: 100,
      onRequest: async () => {
        // Should not be called
      },
      onError: (error: unknown) => {
        errorCaught = error;
      },
    });

    watcher.start();

    await writeFile(
      join(nsDir, "bad-json.request.json"),
      "this is not valid json{{{",
    );

    await waitFor(async () => errorCaught !== null);
    expect(errorCaught).not.toBeNull();

    watcher.stop();
  });

  test("request file too large is rejected", async () => {
    const nsDir = join(tempDir, "echo");
    await mkdir(nsDir, { recursive: true });

    let errorCaught: unknown = null;

    const watcher = createWatcher({
      directory: tempDir,
      pollIntervalMs: 100,
      onRequest: async () => {
        // Should not be called
      },
      onError: (error: unknown) => {
        errorCaught = error;
      },
    });

    watcher.start();

    // Write a file larger than 64KB
    const largeContent = "x".repeat(70000);
    await writeFile(
      join(nsDir, "too-large.request.json"),
      largeContent,
    );

    await waitFor(async () => errorCaught !== null);
    expect(errorCaught).toBeInstanceOf(Error);
    expect((errorCaught as Error).message).toContain("too large");

    watcher.stop();
  });

  test("invalid ID in filename is rejected", async () => {
    const nsDir = join(tempDir, "echo");
    await mkdir(nsDir, { recursive: true });

    let errorCaught: unknown = null;

    const watcher = createWatcher({
      directory: tempDir,
      pollIntervalMs: 100,
      onRequest: async () => {
        // Should not be called
      },
      onError: (error: unknown) => {
        errorCaught = error;
      },
    });

    watcher.start();

    // Create a file with an invalid ID (contains spaces)
    await writeFile(
      join(nsDir, "invalid id with spaces.request.json"),
      JSON.stringify(makeValidRequest()),
    );

    await waitFor(async () => errorCaught !== null);
    expect(errorCaught).toBeInstanceOf(Error);
    expect((errorCaught as Error).message).toContain("Invalid request ID");

    watcher.stop();
  });

  test("recovers orphaned .processing.json on restart", async () => {
    const nsDir = join(tempDir, "echo");
    await mkdir(nsDir, { recursive: true });

    // Simulate an orphaned .processing.json from a previous crash
    await writeFile(
      join(nsDir, "orphan-001.processing.json"),
      JSON.stringify({ ...makeValidRequest(), id: "orphan-001" }),
    );

    let receivedRequest: Request | null = null;

    const watcher = createWatcher({
      directory: tempDir,
      pollIntervalMs: 100,
      onRequest: async (request: Request) => {
        receivedRequest = request;
      },
    });

    watcher.start();

    await waitFor(async () => receivedRequest !== null);
    expect(receivedRequest!.id).toBe("orphan-001");

    watcher.stop();
  });

  test("onRequest throwing results in .failed.json (not infinite loop)", async () => {
    const nsDir = join(tempDir, "echo");
    await mkdir(nsDir, { recursive: true });

    let errorCount = 0;

    const watcher = createWatcher({
      directory: tempDir,
      pollIntervalMs: 100,
      onRequest: async () => {
        throw new Error("handler exploded");
      },
      onError: () => {
        errorCount++;
      },
    });

    watcher.start();

    await writeFile(
      join(nsDir, "fail-001.request.json"),
      JSON.stringify({ ...makeValidRequest(), id: "fail-001" }),
    );

    // Wait for the error to be reported
    await waitFor(async () => errorCount > 0);

    // Give a couple more poll cycles to confirm no re-processing loop
    await new Promise((r) => setTimeout(r, 500));

    // Should have been called exactly once (not looping)
    expect(errorCount).toBe(1);

    // The .failed.json file should exist
    const files = await readdir(nsDir);
    const failedFiles = files.filter((f) => f.endsWith(".failed.json"));
    expect(failedFiles).toHaveLength(1);
    expect(failedFiles[0]).toBe("fail-001.failed.json");

    // No .processing.json or .request.json should remain
    const processingFiles = files.filter((f) => f.endsWith(".processing.json"));
    const requestFiles = files.filter((f) => f.endsWith(".request.json"));
    expect(processingFiles).toHaveLength(0);
    expect(requestFiles).toHaveLength(0);

    watcher.stop();
  });

  test("recovery skips .processing.json when response already exists", async () => {
    const nsDir = join(tempDir, "echo");
    await mkdir(nsDir, { recursive: true });

    // Simulate: processing file left behind but response was already written
    await writeFile(
      join(nsDir, "completed-001.processing.json"),
      JSON.stringify({ ...makeValidRequest(), id: "completed-001" }),
    );
    await writeFile(
      join(nsDir, "completed-001.response.jsonl"),
      '{"type":"done","exit_code":0,"completed_at":"2026-04-05T12:00:00Z"}\n',
    );

    let called = false;

    const watcher = createWatcher({
      directory: tempDir,
      pollIntervalMs: 100,
      onRequest: async () => {
        called = true;
      },
    });

    watcher.start();

    // Wait a few poll cycles
    await new Promise((r) => setTimeout(r, 500));

    // The handler should NOT have been called — the request was already completed
    expect(called).toBe(false);

    // The .processing.json should be cleaned up
    const files = await readdir(nsDir);
    const processingFiles = files.filter((f) => f.endsWith(".processing.json"));
    expect(processingFiles).toHaveLength(0);

    // The response file should still exist
    expect(files).toContain("completed-001.response.jsonl");

    watcher.stop();
  });

  test(".failed.json files are not recovered", async () => {
    const nsDir = join(tempDir, "echo");
    await mkdir(nsDir, { recursive: true });

    // Place a .failed.json file (dead-letter queue)
    await writeFile(
      join(nsDir, "dead-001.failed.json"),
      JSON.stringify({ ...makeValidRequest(), id: "dead-001" }),
    );

    let called = false;

    const watcher = createWatcher({
      directory: tempDir,
      pollIntervalMs: 100,
      onRequest: async () => {
        called = true;
      },
    });

    watcher.start();

    // Wait a few poll cycles
    await new Promise((r) => setTimeout(r, 500));

    // The handler should NOT have been called
    expect(called).toBe(false);

    // The .failed.json should still be there, untouched
    const files = await readdir(nsDir);
    expect(files).toContain("dead-001.failed.json");

    watcher.stop();
  });
});
