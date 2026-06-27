import { z } from "zod";

// Canonical parsed-paper shape stored in Paper.parsedStructure (JSON).
// Both review-gen (Python) and the API consume this. Produced by either
// Marker (PDF uploads) or arxiv2md (arXiv URL uploads); if parsing
// fails, the paper transitions to PARSE_FAILED and nothing downstream
// runs.

export const ParsedSectionSchema = z.object({
  heading: z.string(),
  level: z.number().int().min(1).max(6),
  text: z.string(),
});

export const ParsedFigureSchema = z.object({
  label: z.string(),                // "Figure 1", "Fig. 3a"
  caption: z.string(),
  page: z.number().int().optional(),
});

export const ParsedTableSchema = z.object({
  label: z.string(),
  caption: z.string(),
  page: z.number().int().optional(),
  // Legacy 2D cell grid from GROBID's <table><row><cell> output. Stays
  // empty for new uploads — Marker emits tables inline in section
  // markdown. Kept for back-compat with historical DB rows.
  rows: z.array(z.array(z.string())).default([]),
});

export const ParsedReferenceSchema = z.object({
  raw: z.string(),                  // verbatim bibliography string
  title: z.string().optional(),
  authors: z.array(z.string()).optional(),
  year: z.number().int().optional(),
});

export const ParsedPaperSchema = z.object({
  title: z.string().nullable(),
  abstract: z.string().nullable(),
  authors: z.array(z.string()),
  sections: z.array(ParsedSectionSchema),
  figures: z.array(ParsedFigureSchema),
  tables: z.array(ParsedTableSchema),
  references: z.array(ParsedReferenceSchema),
  pageCount: z.number().int().nullable(),
  // Parsers in active use:
  //   - "chandra" : Datalab Chandra OCR-2 (vision-LM) via the hosted
  //                 /convert API — the only PDF parser path.
  //   - "arxiv2md": fast-path for arXiv-ID/URL uploads via arXiv's HTML.
  // Marker and GROBID have been retired.
  source: z.union([
    z.literal("chandra"),
    z.literal("arxiv2md"),
  ]),
  // ─── Fairness: canonical input (docs/FAIRNESS.md A1) ───────────────────
  // The ONE canonical paper string, rendered once at parse time to the
  // fair input budget, handed byte-identically to every system.
  // canonicalTokens = its reference-token count; fullTokens = the
  // untruncated paper's token count (for fraction-of-paper-used + length
  // banding). Optional for back-compat with rows parsed before this.
  canonicalText: z.string().nullable().optional(),
  canonicalTokens: z.number().int().nullable().optional(),
  fullTokens: z.number().int().nullable().optional(),
});

export type ParsedSection = z.infer<typeof ParsedSectionSchema>;
export type ParsedFigure = z.infer<typeof ParsedFigureSchema>;
export type ParsedTable = z.infer<typeof ParsedTableSchema>;
export type ParsedReference = z.infer<typeof ParsedReferenceSchema>;
export type ParsedPaper = z.infer<typeof ParsedPaperSchema>;
