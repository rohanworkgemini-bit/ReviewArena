import { z } from "zod";

// Production-grade env validation. All secrets are required with sane
// minimum lengths so misconfigured deployments fail fast at startup.
const ConfigSchema = z.object({
  DATABASE_URL: z.string().url(),
  API_PORT: z.coerce.number().int().default(8000),

  // Bearer token for admin endpoints (/admin/*). 32+ chars random.
  ADMIN_TOKEN: z.string().min(32),

  // HMAC key for pair tokens. SEPARATE from ADMIN_TOKEN so rotating
  // the admin password does not invalidate in-flight pairs, and so
  // leaking the admin token does not let an attacker forge votes.
  PAIR_TOKEN_SECRET: z.string().min(32),

  // CORS whitelist. The browser app's origin. Comma-separated for
  // multiple environments (e.g. "http://localhost:5173,https://reviewarena.example").
  WEB_ORIGIN: z.string().min(1).default("http://localhost:5173"),

  REVIEW_GEN_URL: z.string().url().default("http://localhost:8001"),
  // Bearer key forwarded on every outbound call to the review-gen Python
  // service. Must match the REVIEW_GEN_API_KEY env var on the Python
  // side. Optional — when empty, the Python service runs in open mode
  // (dev only; it logs a startup warning). REQUIRE a value in
  // production, otherwise any internet caller can spend your LLM
  // budget by hitting /generate directly.
  REVIEW_GEN_API_KEY: z.string().default(""),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:");
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

/** Split WEB_ORIGIN ("a,b,c") into a list for the CORS middleware. */
export function webOriginList(config: Config): string[] {
  return config.WEB_ORIGIN.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
