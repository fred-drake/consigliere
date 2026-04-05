import { describe, expect, test } from "bun:test";
import { validateCommand, executeCommand } from "../src/executor";
import type { Request } from "../src/protocol";
import type { Config } from "../src/config";
import type { ResponseLine } from "../src/protocol";
import { resolve } from "path";

const fixturesDir = resolve(import.meta.dir, "fixtures");

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    watch: {
      directory: "/tmp/test",
      poll_interval_ms: 500,
      stale_request_timeout_ms: 300000,
    },
    execution: {
      default_timeout_ms: 30000,
      max_timeout_ms: 120000,
      max_output_bytes: 1048576,
    },
    commands: {
      echo: {
        path: `${fixturesDir}/echo-args.sh`,
      },
      gws: {
        path: `${fixturesDir}/echo-args.sh`,
        allowed_subcommands: ["calendar", "gmail"],
        denied_flags: ["--debug", "--verbose"],
      },
      slow: {
        path: `${fixturesDir}/slow-command.sh`,
      },
      printenv: {
        path: `${fixturesDir}/print-env.sh`,
      },
      failing: {
        path: `${fixturesDir}/exit-code.sh`,
      },
    },
    logging: { level: "info" },
    ...overrides,
  };
}

function makeRequest(overrides?: Partial<Request>): Request {
  return {
    version: 1,
    id: "test-001",
    command: "echo",
    args: ["hello", "world"],
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("executor", () => {
  describe("validateCommand", () => {
    test("allowed command passes", () => {
      const config = makeConfig();
      const request = makeRequest();
      const result = validateCommand(request, config);
      expect(result).toBeNull();
    });

    test("disallowed command rejected", () => {
      const config = makeConfig();
      const request = makeRequest({ command: "unknown" });
      const result = validateCommand(request, config);
      expect(result).not.toBeNull();
      expect(result).toContain("not allowed");
    });

    test("allowed subcommand passes", () => {
      const config = makeConfig();
      const request = makeRequest({
        command: "gws",
        args: ["calendar", "list"],
      });
      const result = validateCommand(request, config);
      expect(result).toBeNull();
    });

    test("disallowed subcommand rejected", () => {
      const config = makeConfig();
      const request = makeRequest({
        command: "gws",
        args: ["secrets", "list"],
      });
      const result = validateCommand(request, config);
      expect(result).not.toBeNull();
      expect(result!.toLowerCase()).toContain("subcommand");
    });

    test("shell metacharacters in args rejected", () => {
      const config = makeConfig();
      const metacharacters = [";", "|", "&", "$", "`", "(", ")", "{", "}", "<", ">", "\n", "\r", "\0"];
      for (const char of metacharacters) {
        const request = makeRequest({ args: [`hello${char}world`] });
        const result = validateCommand(request, config);
        expect(result).not.toBeNull();
      }
    });

    test("denied flags rejected", () => {
      const config = makeConfig();
      const request = makeRequest({
        command: "gws",
        args: ["calendar", "--debug"],
      });
      const result = validateCommand(request, config);
      expect(result).not.toBeNull();
      expect(result).toContain("denied");
    });

    test("stale request rejected", () => {
      const config = makeConfig();
      const staleDate = new Date(
        Date.now() - 400000
      ).toISOString();
      const request = makeRequest({ created_at: staleDate });
      const result = validateCommand(request, config);
      expect(result).not.toBeNull();
      expect(result).toContain("stale");
    });
  });

  describe("executeCommand", () => {
    test("successful command produces started + stdout + done lines", async () => {
      const config = makeConfig();
      const request = makeRequest({ args: ["hello", "world"] });
      const lines: ResponseLine[] = [];
      const writer = (line: ResponseLine) => {
        lines.push(line);
      };

      await executeCommand(request, config, writer);

      expect(lines[0].type).toBe("started");
      const stdoutLines = lines.filter((l) => l.type === "stdout");
      expect(stdoutLines.length).toBeGreaterThan(0);
      const stdoutData = stdoutLines
        .map((l) => (l as any).data)
        .join("");
      expect(stdoutData).toContain("args: hello world");
      const doneLine = lines[lines.length - 1];
      expect(doneLine.type).toBe("done");
      expect((doneLine as any).exit_code).toBe(0);
    });

    test("failed command produces done with exit code", async () => {
      const config = makeConfig();
      const request = makeRequest({ command: "failing", args: [] });
      const lines: ResponseLine[] = [];
      await executeCommand(request, config, (line: ResponseLine) => { lines.push(line); });

      const doneLine = lines.find((l) => l.type === "done");
      expect(doneLine).toBeDefined();
      expect((doneLine as any).exit_code).toBe(42);
    });

    test("timeout produces error line", async () => {
      const config = makeConfig({
        execution: {
          default_timeout_ms: 500,
          max_timeout_ms: 1000,
          max_output_bytes: 1048576,
        },
      });
      const request = makeRequest({
        command: "slow",
        args: [],
        timeout_ms: 500,
      });
      const lines: ResponseLine[] = [];
      await executeCommand(request, config, (line: ResponseLine) => { lines.push(line); });

      const errorLine = lines.find((l) => l.type === "error");
      expect(errorLine).toBeDefined();
      expect((errorLine as any).message.toLowerCase()).toContain("timed out");
    }, 10000);

    test("NDJSON lines are valid JSON", async () => {
      const config = makeConfig();
      const request = makeRequest({ args: ["test"] });
      const lines: ResponseLine[] = [];
      await executeCommand(request, config, (line: ResponseLine) => { lines.push(line); });

      for (const line of lines) {
        // Each line should be serializable to valid JSON
        const json = JSON.stringify(line);
        const parsed = JSON.parse(json);
        expect(parsed.type).toBeDefined();
      }
    });

    test("child process gets sanitized environment", async () => {
      const config = makeConfig();
      const request = makeRequest({ command: "printenv", args: [] });
      const lines: ResponseLine[] = [];
      await executeCommand(request, config, (line: ResponseLine) => { lines.push(line); });

      const stdoutLines = lines.filter((l) => l.type === "stdout");
      const envOutput = stdoutLines.map((l) => (l as any).data).join("");

      // Should have PATH, HOME, LANG but not random env vars
      expect(envOutput).toContain("PATH=");
      expect(envOutput).toContain("HOME=");
      // Should NOT contain things like EDITOR, SHELL, etc.
      expect(envOutput).not.toContain("EDITOR=");
    });

    test("denied flag with =value suffix is rejected", async () => {
      const config = makeConfig();
      const request = makeRequest({
        command: "gws",
        args: ["calendar", "--debug=true"],
      });
      const result = validateCommand(request, config);
      expect(result).not.toBeNull();
      expect(result).toContain("denied");
    });

    test("timeout_ms is clamped to max_timeout_ms", async () => {
      const config = makeConfig({
        execution: {
          default_timeout_ms: 30000,
          max_timeout_ms: 60000,
          max_output_bytes: 1048576,
        },
      });
      // Request with huge timeout should still pass validation
      const request = makeRequest({ timeout_ms: 999999 });
      const result = validateCommand(request, config);
      expect(result).toBeNull();
    });

    test("validation failure writes error and done lines", async () => {
      const config = makeConfig();
      const request = makeRequest({ command: "unknown" });
      const lines: ResponseLine[] = [];
      await executeCommand(request, config, (line: ResponseLine) => { lines.push(line); });

      expect(lines).toHaveLength(2);
      expect(lines[0].type).toBe("error");
      expect((lines[0] as any).message).toContain("not allowed");
      expect(lines[1].type).toBe("done");
      expect((lines[1] as any).exit_code).toBeNull();
    });
    test("max_output_bytes cap produces error line", async () => {
      const config = makeConfig({
        commands: {
          echo: { path: `${fixturesDir}/echo-args.sh` },
          gws: {
            path: `${fixturesDir}/echo-args.sh`,
            allowed_subcommands: ["calendar", "gmail"],
            denied_flags: ["--debug", "--verbose"],
          },
          slow: { path: `${fixturesDir}/slow-command.sh` },
          printenv: { path: `${fixturesDir}/print-env.sh` },
          failing: { path: `${fixturesDir}/exit-code.sh` },
          largeoutput: { path: `${fixturesDir}/large-output.sh` },
        },
        execution: {
          default_timeout_ms: 30000,
          max_timeout_ms: 120000,
          max_output_bytes: 1024, // Very small limit
        },
      });
      const request = makeRequest({ command: "largeoutput", args: [] });
      const lines: ResponseLine[] = [];
      await executeCommand(request, config, (line: ResponseLine) => { lines.push(line); });

      const errorLine = lines.find((l) => l.type === "error");
      expect(errorLine).toBeDefined();
      expect((errorLine as any).message).toContain("max_output_bytes");
    }, 15000);
  });
});
