"""Shared INPUT/OUTPUT budget — the fairness core.

FAIRNESS CONTRACT (see docs/FAIRNESS.md, invariants A1 + A4):

  Every system reviewing a paper receives the BYTE-IDENTICAL canonical
  text and the SAME output-token cap. Context-window size and verbosity
  allowance are equalized away so the only variable is the reviewing
  itself. This is the controlled-experiment design: "review quality given
  equal resources", not "systems as they happen to be configured".

  - FAIR_INPUT_TOKENS:  the paper-text budget handed to EVERY system.
  - FAIR_OUTPUT_TOKENS: the max output tokens EVERY system may produce.

  Both are measured with ONE reference tokenizer (tiktoken cl100k_base)
  so the unit is identical across systems regardless of each model's own
  tokenizer. The canonical text is rendered ONCE per paper and reused
  verbatim — adapters never re-render or re-truncate.

  FAIR_INPUT + FAIR_OUTPUT + overhead must fit inside the SMALLEST
  system's context window so no system silently truncates further. Our
  smallest enabled window is 16k (GPT/Gemini/SEA); 11000 + 3072 + ~1500
  = ~15.6k < 16k. DeepReviewer's training cap is 14k input — 11k fits.
"""
from __future__ import annotations

from math import ceil

from app.paper_render import render_paper_text, render_paper_text_scoped
from app.schemas import ParsedPaper, ReviewScope

# ─── the fair budget (identical for every system) ──────────────────────────
FAIR_INPUT_TOKENS = 11_000
FAIR_OUTPUT_TOKENS = 3072

# Conservative chars-per-token fallback when tiktoken is unavailable.
_CHARS_PER_TOKEN = 3.6

# Lazily-loaded reference tokenizer. One encoding for ALL systems so the
# token unit is consistent (fairness requires a common ruler, not each
# model's own tokenizer).
_ENCODER = None
_ENCODER_TRIED = False


def _encoder():
    global _ENCODER, _ENCODER_TRIED
    if _ENCODER_TRIED:
        return _ENCODER
    _ENCODER_TRIED = True
    try:
        import tiktoken  # type: ignore[import-not-found]

        _ENCODER = tiktoken.get_encoding("cl100k_base")
    except Exception:  # noqa: BLE001 — fall back to the char heuristic
        _ENCODER = None
    return _ENCODER


def count_tokens(text: str) -> int:
    """Reference token count. tiktoken cl100k_base when available, else a
    conservative char estimate. The SAME function is used for every system,
    so counts are comparable even if absolute values are approximate."""
    if not text:
        return 0
    enc = _encoder()
    if enc is not None:
        return len(enc.encode(text))
    return ceil(len(text) / _CHARS_PER_TOKEN)


def _char_budget_for_tokens(max_tokens: int) -> int:
    return max(0, int(max_tokens * _CHARS_PER_TOKEN))


def render_canonical(paper: ParsedPaper, *, max_input_tokens: int = FAIR_INPUT_TOKENS) -> str:
    """Render the ONE canonical paper string handed to every system.

    Deterministic from the parsed structure: same paper → same string.
    Section-aware truncation (title/abstract/conclusion preserved) is done
    by render_paper_text; we trim to the fair token budget using the
    reference tokenizer so the result is exactly FAIR_INPUT_TOKENS or
    fewer, measured identically for all systems.
    """
    # First pass: a generous char budget so render_paper_text keeps the
    # right sections, then trim precisely by reference tokens.
    text = render_paper_text(paper, max_chars=_char_budget_for_tokens(max_input_tokens) * 2)
    return _trim_to_tokens(text, max_input_tokens)


def render_canonical_scoped(
    paper: ParsedPaper,
    *,
    selected_section_ids: list[int],
    max_input_tokens: int = FAIR_INPUT_TOKENS,
) -> tuple[str, ReviewScope]:
    """Render canonical text restricted to user-selected sections.

    Returns the canonical text AND a ReviewScope record describing what
    was actually shared. The canonical text contains a [REVIEW SCOPE]
    notice listing included/omitted sections, instructing the model to
    review only the included content. Selected sections are emitted at
    full fidelity (no per-section caps); if the total exceeds
    FAIR_INPUT_TOKENS we still trim — but the upstream UI should prevent
    that with a live budget meter.
    """
    text, included_headings, omitted_headings = render_paper_text_scoped(
        paper, selected_section_ids
    )
    text = _trim_to_tokens(text, max_input_tokens)
    # Normalize the IDs the same way render_paper_text_scoped did so the
    # ReviewScope record matches what was rendered.
    n_sections = len(paper.sections)
    normalized_ids = sorted({i for i in selected_section_ids if 0 <= i < n_sections})
    scope = ReviewScope(
        included_section_ids=normalized_ids,
        included_headings=included_headings,
        omitted_headings=omitted_headings,
        canonical_tokens=count_tokens(text),
    )
    return text, scope


# Reserve tokens for the truncation marker so the final string (marker
# included) still fits within the budget.
_TRUNCATION_MARKER = "\n\n[… truncated to fair input budget]"
_MARKER_TOKENS = 16


def _trim_to_tokens(text: str, max_tokens: int) -> str:
    """Trim text to at most max_tokens reference tokens (marker included),
    on a paragraph boundary where possible so we never cut mid-word."""
    if count_tokens(text) <= max_tokens:
        return text
    body_budget = max(1, max_tokens - _MARKER_TOKENS)
    enc = _encoder()
    if enc is not None:
        toks = enc.encode(text)[:body_budget]
        out = enc.decode(toks)
    else:
        out = text[: _char_budget_for_tokens(body_budget)]
    # Back off to the last paragraph break so we end cleanly.
    cut = out.rfind("\n\n")
    if cut > len(out) * 0.6:
        out = out[:cut]
    return out.rstrip() + _TRUNCATION_MARKER
