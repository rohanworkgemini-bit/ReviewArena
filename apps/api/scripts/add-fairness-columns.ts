// One-shot: add the fairness columns (docs/FAIRNESS.md A1/A4/C1).
// Idempotent — every ADD COLUMN uses IF NOT EXISTS.
//
// Run via:
//   pnpm --filter @reviewarena/api exec tsx scripts/add-fairness-columns.ts
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

import { db } from "../src/db/client.js";
import { sql } from "drizzle-orm";

// papers — canonical input + length band (A1 / C1)
await db.execute(sql`
  ALTER TABLE "papers"
    ADD COLUMN IF NOT EXISTS "canonical_text" text,
    ADD COLUMN IF NOT EXISTS "canonical_tokens" integer,
    ADD COLUMN IF NOT EXISTS "full_tokens" integer,
    ADD COLUMN IF NOT EXISTS "length_band" text
`);

// reviews — per-generation token accounting (A4)
await db.execute(sql`
  ALTER TABLE "reviews"
    ADD COLUMN IF NOT EXISTS "input_tokens_sent" integer,
    ADD COLUMN IF NOT EXISTS "input_tokens_consumed" integer,
    ADD COLUMN IF NOT EXISTS "context_window" integer,
    ADD COLUMN IF NOT EXISTS "output_tokens" integer,
    ADD COLUMN IF NOT EXISTS "time_to_first_token_ms" integer
`);

console.log("Fairness columns present on papers + reviews.");
process.exit(0);
