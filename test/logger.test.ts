import { describe, expect, test } from "bun:test";
import { createLogger } from "../src/logger";

function createBuffer(): { write(s: string): void; lines: string[] } {
  const lines: string[] = [];
  return {
    write(s: string) {
      lines.push(s);
    },
    lines,
  };
}

describe("logger", () => {
  test("logs at configured level and above", () => {
    const buf = createBuffer();
    const logger = createLogger("warn", buf);
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(buf.lines).toHaveLength(2);
    expect(JSON.parse(buf.lines[0]).level).toBe("warn");
    expect(JSON.parse(buf.lines[1]).level).toBe("error");
  });

  test("suppresses logs below configured level", () => {
    const buf = createBuffer();
    const logger = createLogger("error", buf);
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    expect(buf.lines).toHaveLength(0);
    logger.error("e");
    expect(buf.lines).toHaveLength(1);
  });

  test("output is valid JSON per line", () => {
    const buf = createBuffer();
    const logger = createLogger("debug", buf);
    logger.info("test message");
    expect(buf.lines).toHaveLength(1);
    const line = buf.lines[0];
    expect(line).toEndWith("\n");
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("info");
    expect(parsed.message).toBe("test message");
  });

  test("context fields are included", () => {
    const buf = createBuffer();
    const logger = createLogger("debug", buf);
    logger.info("request processed", { requestId: "abc-123", duration: 42 });
    const parsed = JSON.parse(buf.lines[0]);
    expect(parsed.requestId).toBe("abc-123");
    expect(parsed.duration).toBe(42);
  });

  test("context fields cannot overwrite level, message, or ts", () => {
    const buf = createBuffer();
    const logger = createLogger("debug", buf);
    logger.info("real message", {
      level: "error",
      message: "fake message",
      ts: "fake-timestamp",
    });
    const parsed = JSON.parse(buf.lines[0]);
    expect(parsed.level).toBe("info");
    expect(parsed.message).toBe("real message");
    expect(parsed.ts).not.toBe("fake-timestamp");
  });

  test("timestamp is present", () => {
    const buf = createBuffer();
    const logger = createLogger("debug", buf);
    logger.info("test");
    const parsed = JSON.parse(buf.lines[0]);
    expect(parsed.ts).toBeDefined();
    expect(typeof parsed.ts).toBe("string");
    // Should be a valid ISO date
    expect(new Date(parsed.ts).toISOString()).toBe(parsed.ts);
  });
});
