import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync } from "fs";
import { loadConfigFromString } from "../src/config";
import { createWatcher } from "../src/watcher";
import { executeCommand } from "../src/executor";
import { serializeLine, type ResponseLine } from "../src/protocol";
import { open } from "fs/promises";

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 10000,
  intervalMs = 50
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timed out");
}

describe("integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function createTempDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "consigliere-integration-"));
  }

  test("end-to-end: request file produces correct response", async () => {
    // Find the real path to echo
    const echoPath = "/bin/echo";

    const configToml = `
[watch]
directory = "${tempDir}"
poll_interval_ms = 100
stale_request_timeout_ms = 300000

[execution]
default_timeout_ms = 30000
max_timeout_ms = 120000
max_output_bytes = 1048576

[commands.echo]
path = "${echoPath}"

[logging]
level = "debug"
`;
    const config = loadConfigFromString(configToml);

    // Create command namespace directory
    const nsDir = join(tempDir, "echo");
    await mkdir(nsDir, { recursive: true });

    const watcher = createWatcher({
      directory: config.watch.directory,
      pollIntervalMs: config.watch.poll_interval_ms,
      onRequest: async (request, responsePath) => {
        let fileHandle;
        try {
          fileHandle = await open(responsePath, "wx");
          const responseWriter = async (line: ResponseLine): Promise<void> => {
            const serialized = serializeLine(line);
            await fileHandle!.write(serialized);
          };
          await executeCommand(request, config, responseWriter);
        } finally {
          if (fileHandle) {
            await fileHandle.close();
          }
        }
      },
    });

    watcher.start();

    // Write a request file
    const request = {
      version: 1,
      id: "integration-test-001",
      command: "echo",
      args: ["hello"],
      created_at: new Date().toISOString(),
    };

    await writeFile(
      join(nsDir, "integration-test-001.request.json"),
      JSON.stringify(request)
    );

    // Wait for response file
    const responsePath = join(nsDir, "integration-test-001.response.jsonl");
    await waitFor(async () => existsSync(responsePath));

    // Wait a bit for all writes to flush
    await new Promise((r) => setTimeout(r, 500));

    // Read and parse response
    const responseContent = await readFile(responsePath, "utf-8");
    const lines = responseContent
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    // Verify response structure
    expect(lines[0].type).toBe("started");
    expect(lines[0].id).toBe("integration-test-001");

    const stdoutLines = lines.filter((l: any) => l.type === "stdout");
    expect(stdoutLines.length).toBeGreaterThan(0);
    const output = stdoutLines.map((l: any) => l.data).join("");
    expect(output).toContain("hello");

    const doneLine = lines[lines.length - 1];
    expect(doneLine.type).toBe("done");
    expect(doneLine.exit_code).toBe(0);

    // Verify .processing.json was cleaned up
    const processingPath = join(
      nsDir,
      "integration-test-001.processing.json"
    );
    expect(existsSync(processingPath)).toBe(false);

    watcher.stop();
  });
});
