// One-shot: drop every table + enum in the public schema, then exit.
// Used to clear the Neon DB before the first drizzle-kit push when the
// database has leftovers from a previous app.
//
// Run: pnpm --filter @reviewarena/api db:nuke

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
// scripts/drop-all.ts → repo-root .env is 4 dirs up.
loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

import { Pool } from "pg";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const tables = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  for (const { tablename } of tables.rows) {
    console.log(`drop table ${tablename}`);
    await pool.query(`DROP TABLE IF EXISTS "${tablename}" CASCADE`);
  }

  const enums = await pool.query<{ typname: string }>(
    `SELECT t.typname
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typtype = 'e'`,
  );
  for (const { typname } of enums.rows) {
    console.log(`drop type ${typname}`);
    await pool.query(`DROP TYPE IF EXISTS "${typname}" CASCADE`);
  }

  console.log(`\nDropped ${tables.rows.length} table(s) and ${enums.rows.length} enum(s).`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
