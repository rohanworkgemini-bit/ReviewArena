// One-shot: drop NOT NULL on papers.pdf_path so new uploads can store
// null (we no longer persist the PDF). Idempotent — safe to re-run; the
// statement is a no-op once the column is already nullable.
//
// Run via: pnpm --filter @reviewarena/api exec tsx scripts/alter-pdf-path-nullable.ts
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

import { db } from "../src/db/client.js";
import { sql } from "drizzle-orm";

await db.execute(sql`ALTER TABLE "papers" ALTER COLUMN "pdf_path" DROP NOT NULL`);
console.log("papers.pdf_path is now nullable");
process.exit(0);
