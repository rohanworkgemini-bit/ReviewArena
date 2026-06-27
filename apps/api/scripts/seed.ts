// Seed review_systems so the demo has something to compare on day one.
// Run: pnpm --filter @reviewarena/api db:seed
//
// Live lineup (per QSL grant plan — 6 commercial + 2 specialists):
//   Commercial frontier reviewers:
//     - GPT-5            (OpenAI, top tier)
//     - GPT-5-mini       (OpenAI, small)
//     - Gemini 3 Pro     (Google, top tier)
//     - Gemini 2.5 Flash (Google, small)
//     - Claude Opus 4.8  (Anthropic, native SDK with adaptive thinking)
//     - DeepSeek V3.2    (deepseek-chat via DeepSeek's OpenAI-compat API)
//   Specialist open-weight fine-tunes (Modal-hosted vLLM):
//     - DeepReviewer-7B   (WestlakeNLP)
//     - OpenReviewer-8B   (maxidl / Llama-3.1)
//     - CycleReviewer-8B  (WestlakeNLP — optional, gated on CYCLEREVIEWER_URL)
//     - SEA-E             (ECNU — optional, gated on SEA_URL)
//
// Older in-process "port" adapters and pre-GPT-5 frontier baselines
// (gpt-4o, claude-sonnet-3.7-via-OpenRouter, etc.) are kept in the DB
// with enabled=false so historical votes / reviews / Elo snapshots
// remain intact for the thesis analysis.

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
// scripts/seed.ts → repo-root .env is 4 dirs up (scripts → api → apps → /).
loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { reviewSystems } from "../src/db/schema.js";

// Slugs of retired adapters. Disabled (not deleted) so historical
// reviews / votes / Elo snapshots remain in the DB for thesis analysis.
const RETIRED_SLUGS = [
  "gpt-4o-mini",            // pre-GPT-5 zero-shot baseline
  "gpt-4o",                 // pre-GPT-5 frontier baseline, replaced by gpt-5
  "gemini-1.5-flash",        // pre-Gemini-2.5 zero-shot baseline
  "claude-sonnet",          // replaced by claude-opus-4-8 via native Anthropic SDK
  "deepseek-v3",            // renamed to deepseek-v3-2 when we adopted per-system adapters
  "ai-scientist-gpt5",       // our port of Sakana's reviewer
  "tree-review-gpt5",         // our port of Chang et al.'s tree-of-questions
  "deepreviewer-14b",         // our port placeholder
];

async function main() {
  // Step 1 — retire the legacy adapters.
  for (const slug of RETIRED_SLUGS) {
    const existing = await db.query.reviewSystems.findFirst({
      where: eq(reviewSystems.slug, slug),
    });
    if (existing?.enabled) {
      await db
        .update(reviewSystems)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(reviewSystems.id, existing.id));
      console.log(`Disabled retired system: ${slug}`);
    }
  }

  // Step 2 — upsert the 4 live systems + 2 mocks (dev fallback).
  const systems: Array<{
    slug: string;
    name: string;
    description: string;
    adapterKey: string;
    config: Record<string, unknown>;
    enabled?: boolean;
  }> = [
    // ─── Live: 6 frontier commercial reviewers (per QSL plan) ─────────
    // Two OpenAI (GPT-5 top + GPT-5-mini), two Google (Gemini 3 Pro top
    // + Gemini 2.5 Flash), one Anthropic (Opus 4.8), one DeepSeek.
    {
      slug: "gpt-5",
      name: "GPT-5 (zero-shot)",
      description:
        "OpenAI GPT-5 (top tier, not -mini) with our zero-shot reviewer prompt. " +
        "Reasoning-class model; uses adaptive thinking by default.",
      adapterKey: "gpt-5",
      config: { model: "gpt-5", use_max_completion_tokens: true },
      enabled: !!process.env.OPENAI_API_KEY,
    },
    {
      slug: "gpt-5-mini",
      name: "GPT-5-mini (zero-shot)",
      description: "OpenAI GPT-5-mini with our zero-shot reviewer prompt.",
      adapterKey: "gpt-5-mini",
      config: { model: "gpt-5-mini", use_max_completion_tokens: true },
      enabled: !!process.env.OPENAI_API_KEY,
    },
    {
      slug: "gemini-3-pro",
      name: "Gemini 3 Pro (zero-shot)",
      description:
        "Google Gemini 3 Pro (top tier) with our zero-shot reviewer prompt. " +
        "Frontier multi-modal model from the Gemini 3 family. " +
        "Currently pinned to 'gemini-3.1-pro-preview' — Google deprecated " +
        "'gemini-3-pro-preview' before the study began.",
      adapterKey: "gemini-3-pro",
      // gemini-3-pro-preview is dead (404). gemini-3.1-pro-preview is the
      // current top-tier Gemini 3 model and IS working. We PIN the preview
      // version so the entire study uses the same model snapshot — switching
      // mid-study would invalidate apples-to-apples comparison.
      // Verify currently-callable IDs with:
      //   for m in "gemini-3.1-pro-preview" "gemini-pro-latest"; do \
      //     curl -sS -o /dev/null -w "$m → %{http_code}\n" \
      //       -X POST "https://generativelanguage.googleapis.com/v1beta/models/$m:generateContent?key=$GEMINI_API_KEY" \
      //       -H "content-type: application/json" \
      //       -d '{"contents":[{"parts":[{"text":"ping"}]}]}'; \
      //   done
      config: { model: "gemini-3.1-pro-preview", temperature: 0.2 },
      enabled: !!process.env.GEMINI_API_KEY,
    },
    {
      slug: "gemini-2.5-flash",
      name: "Gemini 2.5 Flash (zero-shot)",
      description: "Google Gemini 2.5 Flash with our zero-shot reviewer prompt.",
      adapterKey: "gemini-2.5-flash",
      config: { model: "gemini-2.5-flash", temperature: 0.2 },
      enabled: !!process.env.GEMINI_API_KEY,
    },
    {
      slug: "claude-opus-4-8",
      name: "Claude Opus 4.8 (zero-shot)",
      description:
        "Anthropic Claude Opus 4.8 via native Anthropic SDK. Adaptive thinking " +
        "(effort=high) — auto-tuned reasoning depth for peer-review judgment.",
      adapterKey: "claude",
      config: { model: "claude-opus-4-8", thinking: true },
      enabled: !!process.env.ANTHROPIC_API_KEY,
    },
    {
      slug: "deepreviewer-7b",
      name: "DeepReviewer-7B",
      description:
        "WestlakeNLP/DeepReviewer-7B (Zhu et al., arxiv:2412.06090). " +
        "Phi-4 / Qwen-2.5 fine-tune for peer review, served via vLLM on Modal GPU. " +
        "Benchmark output only — not for formal peer review (per DeepReviewer License).",
      adapterKey: "deepreviewer-7b",
      // temperature 0.4 per the DeepReview paper's inference settings
      // (arxiv:2503.08569 §inference). The earlier 0.2 was far below the
      // model's own generation_config default (0.6) and caused
      // degeneration loops on dense papers.
      config: { model: "WestlakeNLP/DeepReviewer-7B", temperature: 0.4 },
    },
    {
      slug: "openreviewer-8b",
      name: "Llama-OpenReviewer-8B",
      description:
        "maxidl/Llama-OpenReviewer-8B (Idahl & Ahmadi, NAACL 2025 System Demos). " +
        "Llama-3.1-8B fine-tuned on 79k expert ICLR / NeurIPS reviews, served via " +
        "vLLM on Modal GPU. Built with Llama (Llama-3.1 Community License).",
      adapterKey: "openreviewer-8b",
      // temperature 0.6 per the model's generation_config.json (top_p 0.9).
      // 0.2 was too low and caused repetition loops.
      config: { model: "maxidl/Llama-OpenReviewer-8B", temperature: 0.6 },
    },

    // ─── Specialist open-weight review models (Modal vLLM) ─────────────
    // Enabled only when their Modal URL is configured in .env (deploy the
    // matching service + warm it first). Until then they stay disabled so
    // pair selection won't pick a system that can't respond.
    {
      slug: "cyclereviewer-8b",
      name: "CycleReviewer-8B",
      description:
        "WestlakeNLP/CycleReviewer-ML-Llama-3.1-8B (Weng et al., CycleResearcher, " +
        "arxiv:2411.00816). Llama-3.1-8B fine-tune; emits multiple reviewer " +
        "opinions, we surface the first. Served via vLLM on Modal GPU. " +
        "Benchmark output only — not for formal peer review (CycleReviewer License).",
      adapterKey: "cyclereviewer-8b",
      config: { model: "WestlakeNLP/CycleReviewer-ML-Llama-3.1-8B", temperature: 0.4 },
      enabled: !!process.env.CYCLEREVIEWER_URL,
    },
    {
      slug: "sea-e",
      name: "SEA-E",
      description:
        "ECNU-SEA/SEA-E (Yu et al., SEA, EMNLP 2024 Findings, arxiv:2407.12857). " +
        "Mistral-7B-Instruct-v0.2 fine-tune for constructive review generation " +
        "(apache-2.0). Served via vLLM on Modal GPU.",
      adapterKey: "sea-e",
      config: { model: "ECNU-SEA/SEA-E", temperature: 0.4 },
      enabled: !!process.env.SEA_URL,
    },

    // ─── DeepSeek (its own dedicated adapter; gpt-4o + claude-sonnet
    // retired — see RETIRED_SLUGS above) ───────────────────────────────
    {
      slug: "deepseek-v3-2",
      name: "DeepSeek V3.2 (zero-shot)",
      description:
        "DeepSeek V3.2 (deepseek-chat) zero-shot reviewer via DeepSeek's native " +
        "OpenAI-compatible endpoint. Strong, low-cost frontier baseline.",
      adapterKey: "deepseek-v3-2",
      config: {
        model: "deepseek-chat",  // DeepSeek aliases this to the current top model (V3.2 as of 2026-06)
        temperature: 0.2,
      },
      enabled: !!process.env.DEEPSEEK_API_KEY,
    },
  ];

  for (const sys of systems) {
    const existing = await db.query.reviewSystems.findFirst({
      where: eq(reviewSystems.slug, sys.slug),
    });
    if (existing) {
      await db
        .update(reviewSystems)
        .set({
          name: sys.name,
          description: sys.description,
          adapterKey: sys.adapterKey,
          config: sys.config,
          enabled: sys.enabled ?? true,
          updatedAt: new Date(),
        })
        .where(eq(reviewSystems.id, existing.id));
      console.log(`Updated: ${sys.slug}`);
    } else {
      await db.insert(reviewSystems).values({
        slug: sys.slug,
        name: sys.name,
        description: sys.description,
        adapterKey: sys.adapterKey,
        config: sys.config,
        enabled: sys.enabled ?? true,
      });
      console.log(`Inserted: ${sys.slug}`);
    }
  }

  const all = await db.query.reviewSystems.findMany();
  const enabled = all.filter((s) => s.enabled);
  console.log(
    `\nSeed complete. ${all.length} systems registered, ${enabled.length} enabled.`,
  );
  console.log(`Enabled: ${enabled.map((s) => s.slug).join(", ")}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
