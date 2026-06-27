// One-shot: add the replay-protection unique index on votes
// (session_id, paper_id, review_a_id, review_b_id). Idempotent — safe
// to re-run via IF NOT EXISTS.
//
// Aborts with a useful message if existing duplicate rows would prevent
// the index from being created; dedup first, then re-run.
//
// Run via: pnpm --filter @reviewarena/api exec tsx scripts/add-votes-replay-uk.ts
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

import { db } from "../src/db/client.js";
import { sql } from "drizzle-orm";

const dupes = await db.execute(sql`
  SELECT session_id, paper_id, review_a_id, review_b_id, count(*) AS n
  FROM votes
  GROUP BY 1, 2, 3, 4
  HAVING count(*) > 1
  LIMIT 5
`);

if (dupes.rowCount && dupes.rowCount > 0) {
  console.error("Refusing to create unique index — duplicate rows exist:");
  for (const row of dupes.rows) console.error(row);
  console.error("Dedup these before re-running.");
  process.exit(1);
}

await db.execute(sql`
  CREATE UNIQUE INDEX IF NOT EXISTS "votes_session_pair_uk"
    ON "votes" ("session_id", "paper_id", "review_a_id", "review_b_id")
`);
console.log("votes_session_pair_uk is now present");
process.exit(0);
