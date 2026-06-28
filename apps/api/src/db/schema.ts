/**
 * Drizzle schema — mirrors the Checkpoint-2 design 1:1.
 *
 * Conventions:
 *   - cuid2 PKs (no Postgres extension required; pure JS).
 *   - explicit indexes on every FK hot-path.
 *   - status enums for async pipelines (parsing, generation).
 *   - jsonb columns store typed payloads; never queried with WHERE.
 *
 * Migrations are managed by drizzle-kit (see drizzle.config.ts).
 */
import { createId } from "@paralleldrive/cuid2";
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const cuid = () => text("id").primaryKey().$defaultFn(() => createId());

// ─── Enums ────────────────────────────────────────────────────────────────

export const paperStatusEnum = pgEnum("paper_status", [
  "UPLOADED",
  "PARSING",
  "PARSED",
  "PARSE_FAILED",
]);

export const reviewStatusEnum = pgEnum("review_status", [
  "PENDING",
  "GENERATING",
  "COMPLETED",
  "FAILED",
]);

export const voteWinnerEnum = pgEnum("vote_winner", ["A", "B", "TIE"]);

export const voteDimensionEnum = pgEnum("vote_dimension", [
  "COMPREHENSIVENESS",
  "CLARITY",
  "FAIRNESS",
  "ACTIONABILITY",
  "CONSTRUCTIVENESS",
  "OBJECTIVITY",
  "RELEVANCE",
  "TECHNICAL_TERMS",
]);

export const metricKindEnum = pgEnum("metric_kind", [
  "BLEU",
  "ROUGE_1",
  "ROUGE_2",
  "ROUGE_L",
  "LLM_JUDGE_OVERALL",
  "LLM_JUDGE_VERIFIABILITY",
]);

export const metricReferenceTypeEnum = pgEnum("metric_reference_type", [
  "NONE",
  "HUMAN_REVIEW",
  "OTHER_SYSTEM",
]);

export const claimVerdictEnum = pgEnum("claim_verdict", [
  "SUPPORTED",
  "CONTRADICTED",
  "UNSUPPORTED",
]);

// ─── Papers ───────────────────────────────────────────────────────────────

export const papers = pgTable(
  "papers",
  {
    id: cuid(),
    // SHA-256 of the PDF bytes. Cache key for review generation.
    contentHash: text("content_hash").notNull(),
    // Title the uploader typed (optional) — kept separate from the
    // parser's extraction so we can show "the human-entered title"
    // without losing either source.
    userTitle: text("user_title"),
    extractedTitle: text("extracted_title"),
    authors: jsonb("authors").$type<string[]>(),
    abstract: text("abstract"),
    // Legacy. Older rows stored a disk path here for /uploads serving;
    // new uploads never persist the PDF, so this is null going forward.
    // Kept on the schema (instead of dropped) so existing rows still read.
    pdfPath: text("pdf_path"),
    pageCount: integer("page_count"),
    status: paperStatusEnum("status").notNull().default("UPLOADED"),
    errorMessage: text("error_message"),
    // Typed JSON shape lives in packages/shared-types/parsed-paper.ts.
    parsedStructure: jsonb("parsed_structure"),
    parserRawXml: text("parser_raw_xml"),
    // ─── Fairness: canonical input (docs/FAIRNESS.md A1/C1) ───────────────
    // The ONE canonical paper string handed byte-identically to every
    // system, rendered once at parse time. canonicalTokens = its
    // reference-token count (capped at the fair input budget); fullTokens
    // = the untruncated paper's token count. lengthBand buckets fullTokens
    // (short/medium/long) for length-as-covariate analysis.
    canonicalText: text("canonical_text"),
    canonicalTokens: integer("canonical_tokens"),
    fullTokens: integer("full_tokens"),
    lengthBand: text("length_band"),
    // The session that uploaded this paper. Used by /reviews/stream/:id
    // to authorise live generation requests — only the original uploader
    // can trigger the (billable) model call. Nullable for legacy rows
    // uploaded before this column existed.
    uploadedBySessionId: text("uploaded_by_session_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // contentHash is NOT unique — re-uploads of the same paper get a
    // fresh row + fresh review pair, so the user can iterate on scope
    // / re-test reviewers without dedup short-circuits.
    contentHashIdx: index("papers_content_hash_idx").on(t.contentHash),
    statusIdx: index("papers_status_idx").on(t.status),
  }),
);

// ─── ReviewSystems ────────────────────────────────────────────────────────

export const reviewSystems = pgTable(
  "review_systems",
  {
    id: cuid(),
    // Stable, human-friendly identifier ("deepreviewer-v1", "gpt-4o-mini").
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    // Adapter dispatch key in the Python service. Often equals slug, but
    // separate so two systems can share an adapter with different configs.
    adapterKey: text("adapter_key").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    // ─── LMArena-style pair-selection knobs ────────────────────────────────
    // Mirror fastchat/serve/gradio_block_arena_anony.py:get_battle_pair so
    // operators can steer sampling without code changes. See
    // apps/api/src/pair/select-pair.ts for how each field is used.
    //
    // Base weight for stage-1 pick. 1.0 is neutral; 0 disables the system.
    sampleWeight: doublePrecision("sample_weight").notNull().default(1.0),
    // Cold-start lever — 5× multiplier on sampleWeight. Flip on for newly-
    // added systems until their voteCount stabilises, then flip back off.
    boost: boolean("boost").notNull().default(false),
    // Temporarily exclude from pairing (e.g. adapter is rate-limited or
    // broken). Different from `enabled`: enabled=false stops *generation*;
    // outage=true keeps existing reviews queryable but skips them in pairs.
    outage: boolean("outage").notNull().default(false),
    // Anonymous-only system — never paired with another anonymous system.
    // Currently unused in our flow (all systems revealed on the reveal screen)
    // but kept for parity in case a future "stealth" model is added.
    anon: boolean("anon").notNull().default(false),
    // Soft preference: slugs of rivals to up-weight when *this* system is
    // picked first. Empty = no preference.
    battleTargets: jsonb("battle_targets").$type<string[]>().notNull().default([]),
    // Hard whitelist (regex strings, "*" treated as ".*"). If non-empty,
    // rivals MUST match one of these patterns. Both sides are checked.
    battleStrictTargets: jsonb("battle_strict_targets").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ slugIdx: uniqueIndex("review_systems_slug_uk").on(t.slug) }),
);

// ─── Reviews ──────────────────────────────────────────────────────────────

export const reviews = pgTable(
  "reviews",
  {
    id: cuid(),
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    reviewSystemId: text("review_system_id")
      .notNull()
      .references(() => reviewSystems.id),
    status: reviewStatusEnum("status").notNull().default("PENDING"),
    errorMessage: text("error_message"),
    // Typed shape in shared-types/structured-review.ts.
    structured: jsonb("structured"),
    rawOutput: text("raw_output"),
    generationMs: integer("generation_ms"),
    // ─── Fairness: per-generation token accounting (docs/FAIRNESS.md A4) ───
    // Proves no silent truncation and feeds verbosity analysis.
    //   inputTokensSent     — canonical tokens handed to the system
    //   inputTokensConsumed — tokens the model actually saw (= sent here,
    //                         since the canonical text fits the fair window)
    //   contextWindow       — the system's native window (logged, not used
    //                         to size input — that is equalized)
    //   outputTokens        — reference-token count of the produced review
    //   timeToFirstTokenMs  — streaming latency to first token (B2)
    inputTokensSent: integer("input_tokens_sent"),
    inputTokensConsumed: integer("input_tokens_consumed"),
    contextWindow: integer("context_window"),
    outputTokens: integer("output_tokens"),
    timeToFirstTokenMs: integer("time_to_first_token_ms"),
    // ─── Scoped review (user-chosen sections) ─────────────────────────────
    // Indexes into the paper's parsed sections array that the user picked
    // before generation. NULL/empty = default full-paper view. When set,
    // /reviews/stream/:id forwards this to review-gen so the model only
    // sees the chosen sections (full fidelity) + a [REVIEW SCOPE] notice.
    selectedSectionIds: jsonb("selected_section_ids").$type<number[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Cache-once invariant: same (paper, system) never regenerates.
    // DB-level so concurrent generation requests can't race past it.
    // (paper, system) is NOT unique — every fresh upload creates new
    // review rows even if the same paper+system pair has been reviewed
    // before. Kept as a non-unique index for query speed.
    paperSystemIdx: index("reviews_paper_system_idx").on(t.paperId, t.reviewSystemId),
    paperIdx: index("reviews_paper_idx").on(t.paperId),
    systemIdx: index("reviews_system_idx").on(t.reviewSystemId),
    statusIdx: index("reviews_status_idx").on(t.status),
  }),
);

// ─── Votes ────────────────────────────────────────────────────────────────

export const votes = pgTable(
  "votes",
  {
    id: cuid(),
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id),
    // Blinded positions. Reveal screen maps them back to system identities.
    // A/B is whatever the user SAW (post coin-flip in selectPair). Canonical
    // dedupe happens via `pairSig` below, not by sorting A/B here — that
    // would leak the swap into other surfaces (the reveal screen relies on
    // these being the as-displayed orientation).
    reviewAId: text("review_a_id").notNull().references(() => reviews.id),
    reviewBId: text("review_b_id").notNull().references(() => reviews.id),
    winner: voteWinnerEnum("winner").notNull(),
    // Anonymous session cookie. No PII column anywhere on this table by design.
    sessionId: text("session_id").notNull(),
    userAgent: text("user_agent"),
    decisionMs: integer("decision_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Canonical pair signature, auto-computed by Postgres as
    // LEAST(a, b) || '|' || GREATEST(a, b). Used by the dedupe index
    // below — order-independent so a session can't slip a second vote
    // through by getting the next /pair call's A/B coin flip to land
    // the opposite way. Generated STORED so the value lives on disk
    // and existing rows backfill on column add.
    pairSig: text("pair_sig")
      .notNull()
      .generatedAlwaysAs(
        sql`LEAST(review_a_id, review_b_id) || '|' || GREATEST(review_a_id, review_b_id)`,
      ),
  },
  (t) => ({
    paperIdx: index("votes_paper_idx").on(t.paperId),
    sessionIdx: index("votes_session_idx").on(t.sessionId),
    createdIdx: index("votes_created_idx").on(t.createdAt),
    reviewAIdx: index("votes_review_a_idx").on(t.reviewAId),
    reviewBIdx: index("votes_review_b_idx").on(t.reviewBId),
    // Replay protection: one session cannot vote on the same (paper, pair)
    // twice — regardless of how A/B happened to land on each /pair call.
    // The old uk on (sessionId, paperId, reviewAId, reviewBId) leaked
    // because the A/B coin flip created two "different" orderings of the
    // same pair; pairSig collapses both into one key.
    sessionPairSigUk: uniqueIndex("votes_session_pair_sig_uk").on(
      t.sessionId,
      t.paperId,
      t.pairSig,
    ),
  }),
);

export const dimensionVotes = pgTable(
  "dimension_votes",
  {
    id: cuid(),
    voteId: text("vote_id")
      .notNull()
      .references(() => votes.id, { onDelete: "cascade" }),
    dimension: voteDimensionEnum("dimension").notNull(),
    // Slider value in [-2, +2]:
    //   < 0 = A better, 0 = tie, > 0 = B better. Magnitude = strength.
    value: integer("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One slider per dimension per vote.
    voteDimUk: uniqueIndex("dimension_votes_vote_dim_uk").on(t.voteId, t.dimension),
    dimIdx: index("dimension_votes_dim_idx").on(t.dimension),
  }),
);

// ─── Elo / leaderboard ────────────────────────────────────────────────────

export const eloSnapshots = pgTable(
  "elo_snapshots",
  {
    id: cuid(),
    reviewSystemId: text("review_system_id")
      .notNull()
      .references(() => reviewSystems.id),
    // null = overall leaderboard; otherwise per-dimension sub-leaderboard.
    dimension: voteDimensionEnum("dimension"),
    rating: doublePrecision("rating").notNull(),
    ratingCiLow: doublePrecision("rating_ci_low").notNull(),
    ratingCiHigh: doublePrecision("rating_ci_high").notNull(),
    voteCount: integer("vote_count").notNull(),
    // Which vote triggered this snapshot; null for batch recomputes.
    triggerVoteId: text("trigger_vote_id").references(() => votes.id),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    systemDimComputedIdx: index("elo_snapshots_system_dim_computed_idx").on(
      t.reviewSystemId,
      t.dimension,
      t.computedAt,
    ),
    computedIdx: index("elo_snapshots_computed_idx").on(t.computedAt),
  }),
);

// ─── Automatic metrics ────────────────────────────────────────────────────

export const metricScores = pgTable(
  "metric_scores",
  {
    id: cuid(),
    reviewId: text("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    kind: metricKindEnum("kind").notNull(),
    value: doublePrecision("value").notNull(),
    referenceType: metricReferenceTypeEnum("reference_type").notNull().default("NONE"),
    meta: jsonb("meta"),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // A given (review, metric, reference-type) is computed once and cached.
    reviewKindRefUk: uniqueIndex("metric_scores_review_kind_ref_uk").on(
      t.reviewId,
      t.kind,
      t.referenceType,
    ),
    kindIdx: index("metric_scores_kind_idx").on(t.kind),
  }),
);

// ─── Paper-grounded reveal ────────────────────────────────────────────────

export const claimChecks = pgTable(
  "claim_checks",
  {
    id: cuid(),
    reviewId: text("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    claimText: text("claim_text").notNull(),
    verdict: claimVerdictEnum("verdict").notNull(),
    evidence: text("evidence"),
    judgeModel: text("judge_model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    reviewIdx: index("claim_checks_review_idx").on(t.reviewId),
    verdictIdx: index("claim_checks_verdict_idx").on(t.verdict),
  }),
);

// ─── Relations (only the joins we actually traverse in code) ──────────────

export const papersRelations = relations(papers, ({ many }) => ({
  reviews: many(reviews),
  votes: many(votes),
}));

export const reviewSystemsRelations = relations(reviewSystems, ({ many }) => ({
  reviews: many(reviews),
  eloSnapshots: many(eloSnapshots),
}));

export const reviewsRelations = relations(reviews, ({ one, many }) => ({
  paper: one(papers, { fields: [reviews.paperId], references: [papers.id] }),
  reviewSystem: one(reviewSystems, {
    fields: [reviews.reviewSystemId],
    references: [reviewSystems.id],
  }),
  metricScores: many(metricScores),
  claimChecks: many(claimChecks),
}));

export const votesRelations = relations(votes, ({ one, many }) => ({
  paper: one(papers, { fields: [votes.paperId], references: [papers.id] }),
  reviewA: one(reviews, {
    fields: [votes.reviewAId],
    references: [reviews.id],
    relationName: "voteReviewA",
  }),
  reviewB: one(reviews, {
    fields: [votes.reviewBId],
    references: [reviews.id],
    relationName: "voteReviewB",
  }),
  dimensions: many(dimensionVotes),
}));

export const dimensionVotesRelations = relations(dimensionVotes, ({ one }) => ({
  vote: one(votes, { fields: [dimensionVotes.voteId], references: [votes.id] }),
}));

export const eloSnapshotsRelations = relations(eloSnapshots, ({ one }) => ({
  reviewSystem: one(reviewSystems, {
    fields: [eloSnapshots.reviewSystemId],
    references: [reviewSystems.id],
  }),
  triggerVote: one(votes, {
    fields: [eloSnapshots.triggerVoteId],
    references: [votes.id],
  }),
}));

export const metricScoresRelations = relations(metricScores, ({ one }) => ({
  review: one(reviews, { fields: [metricScores.reviewId], references: [reviews.id] }),
}));

export const claimChecksRelations = relations(claimChecks, ({ one }) => ({
  review: one(reviews, { fields: [claimChecks.reviewId], references: [reviews.id] }),
}));

// ─── Type re-exports for convenience ──────────────────────────────────────

export type Paper = typeof papers.$inferSelect;
export type NewPaper = typeof papers.$inferInsert;
export type ReviewSystem = typeof reviewSystems.$inferSelect;
export type NewReviewSystem = typeof reviewSystems.$inferInsert;
export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
export type Vote = typeof votes.$inferSelect;
export type NewVote = typeof votes.$inferInsert;
export type DimensionVote = typeof dimensionVotes.$inferSelect;
export type EloSnapshot = typeof eloSnapshots.$inferSelect;
export type MetricScore = typeof metricScores.$inferSelect;
export type ClaimCheck = typeof claimChecks.$inferSelect;
