// One-shot: add papers.uploaded_by_session_id. Idempotent.
//
// Run via:
//   pnpm --filter @reviewarena/api exec tsx scripts/add-paper-uploaded-by-session.ts
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

import { db } from "../src/db/client.js";
import { sql } from "drizzle-orm";

await db.execute(sql`
  ALTER TABLE "papers"
    ADD COLUMN IF NOT EXISTS "uploaded_by_session_id" text
`);
console.log("papers.uploaded_by_session_id is now present");
process.exit(0);
