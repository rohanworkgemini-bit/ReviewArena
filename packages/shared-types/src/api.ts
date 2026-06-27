import { z } from "zod";
import { VoteDimensionSchema } from "./dimensions.js";
import { StructuredReviewSchema } from "./structured-review.js";

// ─── Shared scalars ─────────────────────────────────────────────────────────

export const CuidSchema = z.string().min(20).max(40);
export const SessionIdSchema = z.string().min(16).max(64);

// ─── POST /papers (upload) ──────────────────────────────────────────────────

export const UploadPaperResponseSchema = z.object({
  paperId: CuidSchema,
  status: z.enum(["UPLOADED", "PARSING", "PARSED", "PARSE_FAILED"]),
  // True if we found an existing Paper by contentHash and reused it.
  deduplicated: z.boolean(),
  // The pair of review IDs the upload-time selector chose. Browser
  // opens SSE streams to /reviews/stream/:reviewId for each to render
  // tokens live. Empty when the parse is still pending (Generate-Mode
  // re-uploads, dedupe hits without re-generation).
  reviewIds: z
    .array(z.object({ slug: z.string(), reviewId: CuidSchema }))
    .default([]),
});
export type UploadPaperResponse = z.infer<typeof UploadPaperResponseSchema>;

// ─── GET /papers/:id ────────────────────────────────────────────────────────

export const PaperSummarySchema = z.object({
  id: CuidSchema,
  title: z.string().nullable(),
  status: z.enum(["UPLOADED", "PARSING", "PARSED", "PARSE_FAILED"]),
  pageCount: z.number().int().nullable(),
  reviewCount: z.number().int(),
  createdAt: z.string(),  // ISO
});
export type PaperSummary = z.infer<typeof PaperSummarySchema>;

// ─── GET /pair (next comparison) ────────────────────────────────────────────

export const ComparisonReviewSchema = z.object({
  reviewId: CuidSchema,
  // The actual structured review the user reads. System identity is hidden.
  // null while the review is still GENERATING — the browser opens an SSE
  // stream to /reviews/stream/:reviewId for token-level rendering and
  // gets the final structured form via the stream's 'done' event.
  structured: StructuredReviewSchema.nullable(),
  status: z.enum(["PENDING", "GENERATING", "COMPLETED", "FAILED"]).optional(),
});

export const PairResponseSchema = z.object({
  paper: z.object({
    id: CuidSchema,
    title: z.string().nullable(),
  }),
  reviewA: ComparisonReviewSchema,
  reviewB: ComparisonReviewSchema,
  // Echoed back with the vote so the server can verify A/B mapping.
  pairToken: z.string(),
});
export type PairResponse = z.infer<typeof PairResponseSchema>;

// ─── POST /votes ────────────────────────────────────────────────────────────

export const SubmitVoteRequestSchema = z.object({
  pairToken: z.string(),
  winner: z.enum(["A", "B", "TIE"]),
  decisionMs: z.number().int().nonnegative().optional(),
  dimensions: z
    .array(
      z.object({
        dimension: VoteDimensionSchema,
        value: z.number().int().min(-2).max(2),
      }),
    )
    .optional(),
});
export type SubmitVoteRequest = z.infer<typeof SubmitVoteRequestSchema>;

export const SubmitVoteResponseSchema = z.object({
  voteId: CuidSchema,
  // Reveal payload — sent in the same response so the UI can transition
  // straight to the reveal screen without a second round-trip.
  reveal: z.object({
    reviewA: z.object({
      reviewId: CuidSchema,
      systemSlug: z.string(),
      systemName: z.string(),
      eloBefore: z.number(),
      eloAfter: z.number(),
    }),
    reviewB: z.object({
      reviewId: CuidSchema,
      systemSlug: z.string(),
      systemName: z.string(),
      eloBefore: z.number(),
      eloAfter: z.number(),
    }),
  }),
});
export type SubmitVoteResponse = z.infer<typeof SubmitVoteResponseSchema>;

// ─── GET /reveal/:voteId ────────────────────────────────────────────────────

export const ClaimVerdictSchema = z.enum(["SUPPORTED", "CONTRADICTED", "UNSUPPORTED"]);
export type ClaimVerdict = z.infer<typeof ClaimVerdictSchema>;

export const RevealSideSchema = z.object({
  reviewId: CuidSchema,
  systemName: z.string(),
  claims: z.array(
    z.object({
      claim: z.string(),
      verdict: ClaimVerdictSchema,
      evidence: z.string().nullable(),
      judgeModel: z.string(),
    }),
  ),
  verifiabilityFraction: z.number().min(0).max(1),
  judgeOverall: z.number().nullable(),
  judgeVerifiability: z.number().nullable(),
  // Per-dimension judge scores in 0..10, keyed by VoteDimension. null until
  // scoring runs.
  judgeDimensions: z.record(z.string(), z.number()).nullable(),
});
export type RevealSide = z.infer<typeof RevealSideSchema>;

export const RevealDetailResponseSchema = z.object({
  reviewA: RevealSideSchema,
  reviewB: RevealSideSchema,
});
export type RevealDetailResponse = z.infer<typeof RevealDetailResponseSchema>;

// ─── GET /leaderboard ───────────────────────────────────────────────────────

export const LeaderboardEntrySchema = z.object({
  rank: z.number().int().min(1),
  systemSlug: z.string(),
  systemName: z.string(),
  rating: z.number(),
  ratingCiLow: z.number(),
  ratingCiHigh: z.number(),
  voteCount: z.number().int().nonnegative(),
});
export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>;

export const LeaderboardResponseSchema = z.object({
  // null = overall, otherwise per-dimension leaderboard.
  dimension: VoteDimensionSchema.nullable(),
  totalPapers: z.number().int().nonnegative(),
  totalVotes: z.number().int().nonnegative(),
  entries: z.array(LeaderboardEntrySchema),
  computedAt: z.string(),
});
export type LeaderboardResponse = z.infer<typeof LeaderboardResponseSchema>;

// ─── Admin: review systems ──────────────────────────────────────────────────

export const ReviewSystemSchema = z.object({
  id: CuidSchema,
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  adapterKey: z.string(),
  enabled: z.boolean(),
  createdAt: z.string(),
});
export type ReviewSystem = z.infer<typeof ReviewSystemSchema>;

export const CreateReviewSystemRequestSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  adapterKey: z.string(),
  config: z.record(z.unknown()).default({}),
});
export type CreateReviewSystemRequest = z.infer<typeof CreateReviewSystemRequestSchema>;

// ─── Generic error envelope ─────────────────────────────────────────────────

export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
