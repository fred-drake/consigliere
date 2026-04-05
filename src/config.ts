import { z } from "zod";
import { parse as parseToml } from "smol-toml";

const CommandConfigSchema = z.object({
  path: z.string().min(1),
  allowed_subcommands: z.array(z.string()).optional(),
  denied_flags: z.array(z.string()).optional(),
});

const ConfigSchema = z.object({
  watch: z.object({
    directory: z.string().min(1),
    poll_interval_ms: z.number().int().positive().default(500),
    stale_request_timeout_ms: z.number().int().positive().default(300000),
  }),
  execution: z
    .object({
      default_timeout_ms: z.number().int().positive().default(30000),
      max_timeout_ms: z.number().int().positive().default(120000),
      max_output_bytes: z.number().int().positive().default(1048576),
    })
    .default({}),
  commands: z.record(z.string(), CommandConfigSchema).default({}),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;
export type CommandConfig = z.infer<typeof CommandConfigSchema>;

const NUMERIC_KEYS = new Set([
  "poll_interval_ms",
  "stale_request_timeout_ms",
  "default_timeout_ms",
  "max_timeout_ms",
  "max_output_bytes",
]);

function applyEnvOverrides(raw: Record<string, any>): Record<string, any> {
  const overrides: Record<string, [string, string]> = {
    CONSIGLIERE_WATCH_DIRECTORY: ["watch", "directory"],
    CONSIGLIERE_WATCH_POLL_INTERVAL_MS: ["watch", "poll_interval_ms"],
    CONSIGLIERE_WATCH_STALE_REQUEST_TIMEOUT_MS: [
      "watch",
      "stale_request_timeout_ms",
    ],
    CONSIGLIERE_EXECUTION_DEFAULT_TIMEOUT_MS: [
      "execution",
      "default_timeout_ms",
    ],
    CONSIGLIERE_EXECUTION_MAX_TIMEOUT_MS: ["execution", "max_timeout_ms"],
    CONSIGLIERE_EXECUTION_MAX_OUTPUT_BYTES: ["execution", "max_output_bytes"],
    CONSIGLIERE_LOGGING_LEVEL: ["logging", "level"],
  };

  for (const [envKey, [section, key]] of Object.entries(overrides)) {
    const value = process.env[envKey];
    if (value !== undefined) {
      if (!raw[section]) {
        raw[section] = {};
      }
      raw[section][key] = NUMERIC_KEYS.has(key) ? Number(value) : value;
    }
  }

  return raw;
}

export function loadConfigFromString(toml: string): Config {
  const raw = parseToml(toml) as Record<string, any>;
  const withOverrides = applyEnvOverrides(raw);
  return ConfigSchema.parse(withOverrides);
}

export async function loadConfig(path?: string): Promise<Config> {
  const configPath =
    path ||
    process.env.CONSIGLIERE_CONFIG_PATH ||
    "/etc/consigliere/consigliere.toml";
  const content = await Bun.file(configPath).text();
  return loadConfigFromString(content);
}
