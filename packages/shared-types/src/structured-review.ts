import { z } from "zod";

// The typed shape every review adapter returns. Stored as Review.structured.
// Modelled on the ICLR/NeurIPS review form so DeepReviewer's output maps
// cleanly without translation.

// Provenance of what the reviewer actually saw. Stamped server-side by
// review-gen after the canonical text is built — works even for specialist
// models (DeepReviewer, OpenReviewer) which can't be asked to emit a scope
// field. Null/undefined when the user reviewed the default full paper.
export const ReviewScopeSchema = z.object({
  included_section_ids: z.array(z.number().int()),
  included_headings: z.array(z.string()),
  omitted_headings: z.array(z.string()),
  canonical_tokens: z.number().int(),
});

export type ReviewScope = z.infer<typeof ReviewScopeSchema>;

export const StructuredReviewSchema = z.object({
  summary: z.string(),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  questions: z.array(z.string()),
  // Numeric ratings on a 1–10 scale (ICLR-style). Optional because some
  // baselines don't produce them.
  soundness: z.number().min(1).max(10).optional(),
  presentation: z.number().min(1).max(10).optional(),
  contribution: z.number().min(1).max(10).optional(),
  overallRating: z.number().min(1).max(10).optional(),
  confidence: z.number().min(1).max(5).optional(),
  review_scope: ReviewScopeSchema.nullish(),
});

export type StructuredReview = z.infer<typeof StructuredReviewSchema>;
