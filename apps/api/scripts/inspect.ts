// Quick DB inspector — shows the latest paper and the status of each of
// its reviews. Useful when "why is GPT not showing up" type questions arise.
//
// Run: pnpm --filter @reviewarena/api db:inspect

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
// scripts/inspect.ts → repo-root .env is 4 dirs up.
loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

import { desc, eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { papers, reviews, reviewSystems } from "../src/db/schema.js";

async function main() {
  const latest = await db.query.papers.findFirst({
    orderBy: desc(papers.createdAt),
  });
  if (!latest) {
    console.log("No papers in DB.");
    process.exit(0);
  }

  console.log("=== Latest paper ===");
  console.log("  id:        ", latest.id);
  console.log("  title:     ", latest.userTitle ?? latest.extractedTitle ?? "(none)");
  console.log("  status:    ", latest.status);
  console.log("  hash:      ", latest.contentHash.slice(0, 16) + "…");
  console.log("  pageCount: ", latest.pageCount);
  if (latest.parsedStructure) {
    const ps = latest.parsedStructure as {
      sections?: { heading: string; text: string }[];
      abstract?: string | null;
    };
    console.log("  abstract:  ", (ps.abstract ?? "(none)").slice(0, 80));
    console.log("  sections:  ", ps.sections?.length ?? 0);
    if (ps.sections && ps.sections.length > 0) {
      const totalChars = ps.sections.reduce((sum, s) => sum + s.text.length, 0);
      console.log("  total text:", totalChars, "chars");
      console.log("  first section:", ps.sections[0]?.heading, "—", (ps.sections[0]?.text ?? "").slice(0, 80));
    }
  } else {
    console.log("  parsedStructure: NULL");
  }
  console.log("");

  const all = await db.query.reviews.findMany({
    where: eq(reviews.paperId, latest.id),
    with: { reviewSystem: true },
  });

  console.log("=== Reviews for latest paper ===");
  if (all.length === 0) {
    console.log("  (none)");
  } else {
    for (const r of all) {
      console.log(`  ${r.reviewSystem.slug.padEnd(20)} status=${r.status.padEnd(10)} gen_ms=${r.generationMs ?? "—"}`);
      if (r.errorMessage) {
        console.log(`    error: ${r.errorMessage.slice(0, 300)}`);
      }
    }
  }
  console.log("");

  const enabled = await db.query.reviewSystems.findMany({
    where: eq(reviewSystems.enabled, true),
  });
  console.log("=== Enabled systems ===");
  for (const s of enabled) {
    console.log(`  ${s.slug.padEnd(20)} adapter=${s.adapterKey} config=${JSON.stringify(s.config)}`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
