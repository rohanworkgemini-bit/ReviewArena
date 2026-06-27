"""Shared OUTPUT contract for markdown-emitting adapters.

DeepReviewer, OpenReviewer, and any future vLLM reviewer emit a markdown
review with `## Summary` / `## Strengths` / ... headings. This module is
the single place that turns that markdown into the canonical
`StructuredReview`, replacing the byte-for-byte-duplicated
`_markdown_to_structured` that lived in both adapters.

Two responsibilities:

1. **Parse** — split on headings, map heading aliases to canonical
   fields, bulletize list sections, pull the score out of each numeric
   section (first non-empty line only, so a stray "2024" in prose can't
   be mistaken for a rating).

2. **Normalize scores to a common scale** — different venues score
   differently. ICLR rates Soundness/Presentation/Contribution on 1-4;
   GPT/Gemini are prompted for 1-10. For a fair cross-system leaderboard
   we rescale everything to StructuredReview's ranges (dims + rating
   1-10, confidence 1-5) and CLAMP, so an out-of-range number from any
   model can never raise a Pydantic ValidationError and 502 the request.
"""
from __future__ import annotations

import re
from enum import Enum

from app.schemas import StructuredReview


class ScoreScale(str, Enum):
    """How a model's raw section scores map onto StructuredReview ranges."""

    #: dims + rating already 1-10 (GPT/Gemini-style prompting).
    TEN_POINT = "ten_point"
    #: ICLR-style: Soundness/Presentation/Contribution on 1-4, overall
    #: Rating on the 1-10 ICLR set, Confidence 1-5. We rescale the 1-4
    #: dims up to 1-10 so they're comparable with the 10-point systems.
    ICLR = "iclr"


# Canonical field <- heading alias map. Lowercased, punctuation-stripped.
_HEADER_MAP = {
    "summary": "summary",
    "strength": "strengths",
    "strengths": "strengths",
    "weakness": "weaknesses",
    "weaknesses": "weaknesses",
    "limitation": "weaknesses",
    "limitations": "weaknesses",
    "question": "questions",
    "questions": "questions",
    "soundness": "soundness",
    "presentation": "presentation",
    "contribution": "contribution",
    "rating": "rating",
    "overall": "rating",
    "overall_rating": "rating",
    "score": "rating",
    "confidence": "confidence",
}

_HEADING_RX = re.compile(r"^#{1,4}\s*(.+?)\s*$", re.MULTILINE)
_NUMBER_RX = re.compile(r"(\d+(?:\.\d+)?)")


def parse_markdown_review(md: str, *, scale: ScoreScale = ScoreScale.ICLR) -> StructuredReview:
    """Turn a markdown review into a normalized StructuredReview."""
    sections = _split_sections(md)

    def pick(key: str) -> str:
        return sections.get(key, "").strip()

    return StructuredReview(
        summary=pick("summary") or "(no summary)",
        strengths=_bulletize(pick("strengths")),
        weaknesses=_bulletize(pick("weaknesses")),
        questions=_bulletize(pick("questions")),
        soundness=normalize_dim(_first_number(pick("soundness")), scale),
        presentation=normalize_dim(_first_number(pick("presentation")), scale),
        contribution=normalize_dim(_first_number(pick("contribution")), scale),
        overallRating=_rating(pick("rating")),
        confidence=_confidence(pick("confidence")),
    )


# ─── section splitting ────────────────────────────────────────────────────


def _split_sections(md: str) -> dict[str, str]:
    out: dict[str, str] = {}
    headings = list(_HEADING_RX.finditer(md))
    for i, h in enumerate(headings):
        name = h.group(1).strip().lower().replace(":", "").replace("-", "_")
        name = re.sub(r"^\d+[.)]\s*", "", name).strip()
        canonical = _HEADER_MAP.get(name)
        if not canonical:
            continue
        body_start = h.end()
        body_end = headings[i + 1].start() if i + 1 < len(headings) else len(md)
        body = md[body_start:body_end].strip()
        # Keep the longest body if a heading appears more than once.
        if canonical not in out or len(body) > len(out[canonical]):
            out[canonical] = body
    return out


def _bulletize(text: str) -> list[str]:
    if not text:
        return []
    items: list[str] = []
    for raw in text.split("\n"):
        cleaned = raw.strip().lstrip("-*•").lstrip("0123456789. )").strip()
        if cleaned:
            items.append(cleaned)
    return items


def _first_number(text: str) -> float | None:
    """First number on the first non-empty line. Scanning only the first
    line stops a stray year/count in prose ("the 2024 paper, rating 7")
    from being read as the score."""
    if not text:
        return None
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        m = _NUMBER_RX.search(line)
        return float(m.group(1)) if m else None
    return None


# ─── score normalization ──────────────────────────────────────────────────


def _clamp(value: float | None, lo: float, hi: float) -> float | None:
    if value is None:
        return None
    return max(lo, min(hi, value))


def normalize_dim(value: float | None, scale: ScoreScale) -> float | None:
    """Soundness/Presentation/Contribution → 1-10.

    ICLR dims come on a 1-4 scale; rescale 1→1, 2→4, 3→7, 4→10 so they're
    comparable with the natively-10-point systems. Out-of-range inputs
    are clamped, never raised."""
    if value is None:
        return None
    if scale is ScoreScale.ICLR:
        # Map [1,4] → [1,10]. Values outside [1,4] are clamped first.
        value = max(1.0, min(4.0, value))
        value = 1.0 + (value - 1.0) * 3.0
    return _clamp(value, 1.0, 10.0)


def _rating(text: str) -> float | None:
    return _clamp(_first_number(text), 1.0, 10.0)


def _confidence(text: str) -> float | None:
    return _clamp(_first_number(text), 1.0, 5.0)
