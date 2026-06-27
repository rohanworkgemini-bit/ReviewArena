"""Pydantic schemas. Mirror packages/shared-types/src so the wire format is
identical to what the Node API sends and expects back."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


# ─── ParsedPaper (input from Node) ─────────────────────────────────────────


class ParsedSection(BaseModel):
    heading: str
    level: int = Field(ge=1, le=6)
    text: str


class ParsedFigure(BaseModel):
    label: str
    caption: str
    page: int | None = None


class ParsedTable(BaseModel):
    label: str
    caption: str
    page: int | None = None
    # 2D cell grid. The current parsers (Chandra, arxiv2md) emit
    # tables inline in section markdown and leave this empty; kept for
    # forward-compat with structured-row parsers.
    rows: list[list[str]] = Field(default_factory=list)


class ParsedReference(BaseModel):
    raw: str
    title: str | None = None
    authors: list[str] | None = None
    year: int | None = None


class ParsedPaper(BaseModel):
    title: str | None
    abstract: str | None
    authors: list[str]
    sections: list[ParsedSection]
    figures: list[ParsedFigure]
    tables: list[ParsedTable]
    references: list[ParsedReference]
    pageCount: int | None
    source: Literal["arxiv2md", "chandra"]
    # ─── Fairness: canonical input (docs/FAIRNESS.md A1) ───────────────────
    # The ONE canonical paper string handed BYTE-IDENTICALLY to every
    # system, rendered once at parse time to the fair input budget. When
    # present, adapters use it verbatim (never re-render), guaranteeing
    # identical input. canonicalTokens = its reference-token count;
    # fullTokens = the untruncated paper's token count (for
    # fraction-of-paper-used accounting).
    canonicalText: str | None = None
    canonicalTokens: int | None = None
    fullTokens: int | None = None


# ─── StructuredReview (output to Node) ─────────────────────────────────────


class ReviewScope(BaseModel):
    """Which sections of the paper were actually shared with the reviewer.

    Stamped server-side after the canonical text is built, so even fine-tuned
    specialist models (DeepReviewer, OpenReviewer, …) — which can't be asked
    to emit a `scope` field — still have provenance on what they saw. The
    judge uses this to scope claim verification: a claim referencing an
    out-of-scope section gets verdict='out_of_scope', not 'unverifiable'.
    """

    included_section_ids: list[int]
    included_headings: list[str]
    omitted_headings: list[str]
    canonical_tokens: int


class StructuredReview(BaseModel):
    summary: str
    strengths: list[str]
    weaknesses: list[str]
    questions: list[str]
    soundness: float | None = Field(default=None, ge=1, le=10)
    presentation: float | None = Field(default=None, ge=1, le=10)
    contribution: float | None = Field(default=None, ge=1, le=10)
    overallRating: float | None = Field(default=None, ge=1, le=10)
    confidence: float | None = Field(default=None, ge=1, le=5)
    review_scope: ReviewScope | None = None


# ─── HTTP envelopes ────────────────────────────────────────────────────────


class GenerateRequest(BaseModel):
    adapter_key: str
    paper: ParsedPaper
    config: dict = Field(default_factory=dict)
    # Original PDF bytes, base64-encoded. Forwarded only for adapters
    # that need raw PDF input (MARG). Optional — None for everything else.
    pdf_b64: str | None = None
    # ─── Section selection (scoped review) ─────────────────────────────────
    # When None, the model sees the canonicalText that was stamped at
    # /parse time (default = full paper, prioritized + tail-truncated).
    # When a list is given (e.g. [0, 2, 5]), canonicalText is re-rendered
    # to include ONLY those sections at full fidelity, with a scope notice
    # in the user message listing what was omitted. Indexes refer to
    # paper.sections positions; title + abstract are always included.
    selected_section_ids: list[int] | None = None


class GenerationMetricsOut(BaseModel):
    """Fairness token accounting returned with every generation (A4)."""

    input_tokens: int = 0
    output_tokens: int = 0
    context_window: int = 0
    fair_input_tokens: int = 0
    fair_output_tokens: int = 0


class GenerateResponse(BaseModel):
    review: StructuredReview
    raw_output: str
    generation_ms: int
    adapter_key: str
    metrics: GenerationMetricsOut | None = None
