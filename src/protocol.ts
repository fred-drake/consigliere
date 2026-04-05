import { z } from "zod";

export const RequestSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/),
  command: z.string().min(1),
  args: z.array(z.string().max(4096)).max(50),
  timeout_ms: z.number().int().positive().optional(),
  created_at: z.string().datetime(),
}).strict();

export type Request = z.infer<typeof RequestSchema>;

const StartedLineSchema = z.object({
  type: z.literal("started"),
  id: z.string(),
  started_at: z.string().datetime(),
});

const StdoutLineSchema = z.object({
  type: z.literal("stdout"),
  data: z.string(),
  ts: z.string().datetime(),
});

const StderrLineSchema = z.object({
  type: z.literal("stderr"),
  data: z.string(),
  ts: z.string().datetime(),
});

const ErrorLineSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
  ts: z.string().datetime(),
});

const DoneLineSchema = z.object({
  type: z.literal("done"),
  exit_code: z.number().int().nullable(),
  completed_at: z.string().datetime(),
});

export const ResponseLineSchema = z.discriminatedUnion("type", [
  StartedLineSchema,
  StdoutLineSchema,
  StderrLineSchema,
  ErrorLineSchema,
  DoneLineSchema,
]);

export type ResponseLine = z.infer<typeof ResponseLineSchema>;

export function parseRequest(json: unknown): Request {
  return RequestSchema.parse(json);
}

export function serializeLine(line: ResponseLine): string {
  return JSON.stringify(line) + "\n";
}
