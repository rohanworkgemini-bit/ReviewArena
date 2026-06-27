import { defineConfig } from "drizzle-kit";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

// Load the project-root .env so `pnpm --filter @reviewarena/api db:push`
// works when run from apps/api/ — drizzle-kit's CWD is the workspace, not
// the monorepo root.
loadEnv({ path: resolve(__dirname, "../../.env") });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://reviewarena:reviewarena@localhost:5432/reviewarena",
  },
  // We use snake_case in SQL, camelCase in TS — Drizzle handles the mapping
  // via the column names in schema.ts.
  strict: true,
  verbose: true,
});
