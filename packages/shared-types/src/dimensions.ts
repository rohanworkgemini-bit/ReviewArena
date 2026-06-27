import { z } from "zod";

// Keep in sync with the VoteDimension enum in apps/api/prisma/schema.prisma.
export const VOTE_DIMENSIONS = [
  "COMPREHENSIVENESS",
  "CLARITY",
  "FAIRNESS",
  "ACTIONABILITY",
  "CONSTRUCTIVENESS",
  "OBJECTIVITY",
  "RELEVANCE",
  "TECHNICAL_TERMS",
] as const;

export const VoteDimensionSchema = z.enum(VOTE_DIMENSIONS);
export type VoteDimension = z.infer<typeof VoteDimensionSchema>;

export const DIMENSION_LABELS: Record<VoteDimension, string> = {
  COMPREHENSIVENESS: "Comprehensiveness",
  CLARITY: "Clarity",
  FAIRNESS: "Fairness",
  ACTIONABILITY: "Actionability",
  CONSTRUCTIVENESS: "Constructiveness",
  OBJECTIVITY: "Objectivity",
  RELEVANCE: "Relevance",
  TECHNICAL_TERMS: "Technical Terms",
};

export const DIMENSION_DESCRIPTIONS: Record<VoteDimension, string> = {
  COMPREHENSIVENESS: "Does the review cover the paper thoroughly?",
  CLARITY: "Is the review well-written and understandable?",
  FAIRNESS: "Balanced treatment of strengths and weaknesses?",
  ACTIONABILITY: "Are suggestions concrete and doable?",
  CONSTRUCTIVENESS: "Helpful framing — guides improvement, not just criticism?",
  OBJECTIVITY: "Free of personal bias or subjective tone?",
  RELEVANCE: "Stays on-topic; addresses the actual paper?",
  TECHNICAL_TERMS: "Appropriate, accurate use of domain vocabulary?",
};
