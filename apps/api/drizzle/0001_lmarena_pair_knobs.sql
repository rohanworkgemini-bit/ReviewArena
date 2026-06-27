-- Adds the LMArena-style pair-selection knobs to review_systems.
-- Apply with `pnpm --filter @reviewarena/api db:push` (the project syncs
-- via push, not migrate). This file is kept as documentation of the delta.

ALTER TABLE "review_systems"
  ADD COLUMN IF NOT EXISTS "sample_weight" double precision NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS "boost" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "outage" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "anon" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "battle_targets" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "battle_strict_targets" jsonb NOT NULL DEFAULT '[]'::jsonb;
