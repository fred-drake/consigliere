import { describe, expect, test } from "bun:test";
import {
  parseRequest,
  serializeLine,
  type ResponseLine,
} from "../src/protocol";

describe("protocol", () => {
  describe("parseRequest", () => {
    const validRequest = {
      version: 1,
      id: "test-request-001",
      command: "gws",
      args: ["calendar", "list"],
      timeout_ms: 5000,
      created_at: "2026-04-05T12:00:00Z",
    };

    test("valid request parses successfully", () => {
      const result = parseRequest(validRequest);
      expect(result.version).toBe(1);
      expect(result.id).toBe("test-request-001");
      expect(result.command).toBe("gws");
      expect(result.args).toEqual(["calendar", "list"]);
      expect(result.timeout_ms).toBe(5000);
      expect(result.created_at).toBe("2026-04-05T12:00:00Z");
    });

    test("missing required fields rejected", () => {
      expect(() => parseRequest({})).toThrow();
      expect(() => parseRequest({ version: 1 })).toThrow();
      expect(() =>
        parseRequest({ version: 1, id: "x", command: "y" })
      ).toThrow();
    });

    test("invalid ID pattern rejected (path traversal chars)", () => {
      expect(() =>
        parseRequest({ ...validRequest, id: "../etc/passwd" })
      ).toThrow();
      expect(() =>
        parseRequest({ ...validRequest, id: "foo/bar" })
      ).toThrow();
      expect(() =>
        parseRequest({ ...validRequest, id: "foo bar" })
      ).toThrow();
      expect(() => parseRequest({ ...validRequest, id: "" })).toThrow();
    });

    test("args exceeding max length rejected", () => {
      const longArg = "a".repeat(4097);
      expect(() =>
        parseRequest({ ...validRequest, args: [longArg] })
      ).toThrow();
    });

    test("args exceeding max count rejected", () => {
      const tooManyArgs = Array(51).fill("arg");
      expect(() =>
        parseRequest({ ...validRequest, args: tooManyArgs })
      ).toThrow();
    });

    test("extra fields in request are rejected (strict mode)", () => {
      expect(() =>
        parseRequest({
          ...validRequest,
          extraField: "should be rejected",
        })
      ).toThrow();
    });

    test("version 2 is rejected", () => {
      expect(() =>
        parseRequest({ ...validRequest, version: 2 })
      ).toThrow();
    });

    test("timeout_ms is optional", () => {
      const { timeout_ms, ...noTimeout } = validRequest;
      const result = parseRequest(noTimeout);
      expect(result.timeout_ms).toBeUndefined();
    });
  });

  describe("serializeLine", () => {
    test("started line serializes correctly", () => {
      const line: ResponseLine = {
        type: "started",
        id: "test-001",
        started_at: "2026-04-05T12:00:00Z",
      };
      const result = serializeLine(line);
      expect(result).toEndWith("\n");
      const parsed = JSON.parse(result);
      expect(parsed.type).toBe("started");
      expect(parsed.id).toBe("test-001");
      expect(parsed.started_at).toBe("2026-04-05T12:00:00Z");
    });

    test("stdout line serializes correctly", () => {
      const line: ResponseLine = {
        type: "stdout",
        data: "hello world",
        ts: "2026-04-05T12:00:00Z",
      };
      const result = serializeLine(line);
      const parsed = JSON.parse(result);
      expect(parsed.type).toBe("stdout");
      expect(parsed.data).toBe("hello world");
    });

    test("stderr line serializes correctly", () => {
      const line: ResponseLine = {
        type: "stderr",
        data: "error occurred",
        ts: "2026-04-05T12:00:00Z",
      };
      const result = serializeLine(line);
      const parsed = JSON.parse(result);
      expect(parsed.type).toBe("stderr");
      expect(parsed.data).toBe("error occurred");
    });

    test("error line serializes correctly", () => {
      const line: ResponseLine = {
        type: "error",
        message: "command not allowed",
        ts: "2026-04-05T12:00:00Z",
      };
      const result = serializeLine(line);
      const parsed = JSON.parse(result);
      expect(parsed.type).toBe("error");
      expect(parsed.message).toBe("command not allowed");
    });

    test("done line serializes correctly", () => {
      const line: ResponseLine = {
        type: "done",
        exit_code: 0,
        completed_at: "2026-04-05T12:00:01Z",
      };
      const result = serializeLine(line);
      const parsed = JSON.parse(result);
      expect(parsed.type).toBe("done");
      expect(parsed.exit_code).toBe(0);
    });

    test("done line with null exit_code serializes correctly", () => {
      const line: ResponseLine = {
        type: "done",
        exit_code: null,
        completed_at: "2026-04-05T12:00:01Z",
      };
      const result = serializeLine(line);
      const parsed = JSON.parse(result);
      expect(parsed.exit_code).toBeNull();
    });
  });
});
