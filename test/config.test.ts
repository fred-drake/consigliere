import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { loadConfigFromString } from "../src/config";

const validToml = `
[watch]
directory = "/shared/consigliere"
poll_interval_ms = 500
stale_request_timeout_ms = 300000

[execution]
default_timeout_ms = 30000
max_timeout_ms = 120000
max_output_bytes = 1048576

[commands.gws]
path = "/usr/local/bin/gws"
allowed_subcommands = ["calendar", "gmail", "drive"]
denied_flags = ["--debug", "--verbose"]

[logging]
level = "info"
`;

const minimalToml = `
[watch]
directory = "/shared/consigliere"

[logging]
level = "info"
`;

describe("config", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("CONSIGLIERE_")) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("CONSIGLIERE_")) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
  });

  test("valid TOML parses correctly", () => {
    const config = loadConfigFromString(validToml);
    expect(config.watch.directory).toBe("/shared/consigliere");
    expect(config.watch.poll_interval_ms).toBe(500);
    expect(config.watch.stale_request_timeout_ms).toBe(300000);
    expect(config.execution.default_timeout_ms).toBe(30000);
    expect(config.execution.max_timeout_ms).toBe(120000);
    expect(config.execution.max_output_bytes).toBe(1048576);
    expect(config.commands.gws.path).toBe("/usr/local/bin/gws");
    expect(config.commands.gws.allowed_subcommands).toEqual([
      "calendar",
      "gmail",
      "drive",
    ]);
    expect(config.commands.gws.denied_flags).toEqual([
      "--debug",
      "--verbose",
    ]);
    expect(config.logging.level).toBe("info");
  });

  test("missing required fields error", () => {
    expect(() => loadConfigFromString("")).toThrow();
    expect(() => loadConfigFromString("[watch]\n")).toThrow();
  });

  test("env var overrides work", () => {
    process.env.CONSIGLIERE_WATCH_DIRECTORY = "/override/path";
    const config = loadConfigFromString(validToml);
    expect(config.watch.directory).toBe("/override/path");
  });

  test("default values applied", () => {
    const config = loadConfigFromString(minimalToml);
    expect(config.watch.poll_interval_ms).toBe(500);
    expect(config.watch.stale_request_timeout_ms).toBe(300000);
    expect(config.execution.default_timeout_ms).toBe(30000);
    expect(config.execution.max_timeout_ms).toBe(120000);
    expect(config.execution.max_output_bytes).toBe(1048576);
  });

  test("empty commands map is valid", () => {
    const config = loadConfigFromString(minimalToml);
    expect(config.commands).toEqual({});
  });

  test("numeric env var override parses correctly", () => {
    process.env.CONSIGLIERE_WATCH_POLL_INTERVAL_MS = "1000";
    const config = loadConfigFromString(validToml);
    expect(config.watch.poll_interval_ms).toBe(1000);
    expect(typeof config.watch.poll_interval_ms).toBe("number");
  });

  test("invalid log level rejected", () => {
    const badToml = `
[watch]
directory = "/shared"

[logging]
level = "trace"
`;
    expect(() => loadConfigFromString(badToml)).toThrow();
  });
});
