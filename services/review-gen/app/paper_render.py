"""Section-aware paper rendering for adapter prompts.

Replaces the naive ``"\\n".join(parts)[:N]`` truncation each adapter used to
do — that silently dropped the back third of every paper, which is exactly
where conclusions, limitations and future-work live. With Chandra (or
arxiv2md) feeding proper sections (and a references list) we can do
strictly better:

  1. Always include title + abstract.
  2. Always include conclusion-like sections (Conclusion / Discussion /
     Limitations / Future Work / Summary) at their full length — these are
     the cheapest signal for review quality.
  3. Pack the remaining char budget with body sections in document order,
     truncating the last one cleanly when we hit the cap.
  4. If budget allows, append a compact references list (one line each:
     "- (Smith 2020) Title") and figure/table captions, so the reviewer
     can ground claims like "citation X is missing" or "Figure 3 …".

Each adapter just calls render_paper_text(paper, max_chars) — no more
per-adapter truncation code, no more per-adapter divergence in what bits
of the paper the model sees.
"""
from __future__ import annotations

from app.schemas import ParsedPaper

# Headings that signal "this is the end of the paper" — case-insensitive
# substring match. Order doesn't matter; we use the set for filtering.
_CONCLUSION_KEYWORDS = (
    "conclusion",
    "discussion",
    "limitation",
    "future work",
    "summary",
)

_REFS_CAP = 50            # at most this many refs in the appendix
_CAPTIONS_CAP = 20         # at most this many figures/tables
_PER_CAPTION_CHARS = 200   # truncate each caption to keep the appendix bounded
_TABLE_ROWS_CAP = 12       # at most this many rows per table in the prompt
_TABLE_COLS_CAP = 8        # at most this many cells per row
_TABLE_CELL_CHARS = 80     # truncate long cells (e.g. multi-sentence "results" cells)


def _is_conclusion(heading: str) -> bool:
    h = heading.lower()
    return any(k in h for k in _CONCLUSION_KEYWORDS)


def _format_references(paper: ParsedPaper) -> str:
    if not paper.references:
        return ""
    lines: list[str] = []
    for ref in paper.references[:_REFS_CAP]:
        author = "?"
        if ref.authors:
            # Surname of the first author = "First Last"[-1].
            parts = ref.authors[0].split()
            author = parts[-1] if parts else "?"
        year = str(ref.year) if ref.year else "?"
        title = (ref.title or ref.raw)[:160]
        lines.append(f"- ({author} {year}) {title}")
    return "# References\n" + "\n".join(lines)


def _format_captions(paper: ParsedPaper) -> str:
    parts: list[str] = []
    for f in paper.figures[:_CAPTIONS_CAP]:
        label = f.label or "figure"
        cap = (f.caption or "")[:_PER_CAPTION_CHARS]
        parts.append(f"- Figure {label}: {cap}")
    for t in paper.tables[:_CAPTIONS_CAP]:
        label = t.label or "table"
        cap = (t.caption or "")[:_PER_CAPTION_CHARS]
        head = f"- Table {label}: {cap}"
        body = _format_table_rows(t.rows)
        parts.append(f"{head}\n{body}" if body else head)
    if not parts:
        return ""
    return "# Figures & tables\n" + "\n".join(parts)


def _format_table_rows(rows: list[list[str]]) -> str:
    """Render a 2D cell grid as a markdown pipe-table.

    The current parsers (Chandra via Datalab, arxiv2md) emit tables
    inline in section markdown and leave `paper.tables[*].rows` empty,
    so this is a no-op for them. Kept for forward-compat in case a
    future parser populates structured rows.

    The first non-empty row becomes the header; a separator row is
    inserted after it so downstream markdown renderers (and LLMs)
    treat it as a table. Ragged rows are padded to the max column
    count seen.
    """
    if not rows:
        return ""
    # Trim to caps + clean cells.
    trimmed: list[list[str]] = []
    for r in rows[:_TABLE_ROWS_CAP]:
        cells = [c.strip().replace("\n", " ")[:_TABLE_CELL_CHARS] for c in r[:_TABLE_COLS_CAP]]
        trimmed.append(cells)
    if not trimmed:
        return ""
    width = max(len(r) for r in trimmed)
    if width == 0:
        return ""
    # Pad rows to uniform width.
    for r in trimmed:
        r += [""] * (width - len(r))
    header, *body = trimmed
    # Escape pipes that already exist in cell text — they'd break the table.
    def fmt(cells: list[str]) -> str:
        return "| " + " | ".join(c.replace("|", "\\|") or " " for c in cells) + " |"
    sep = "| " + " | ".join(["---"] * width) + " |"
    lines = [fmt(header), sep, *(fmt(r) for r in body)]
    return "\n".join(lines)


def render_paper_text_scoped(
    paper: ParsedPaper,
    selected_section_ids: list[int],
) -> tuple[str, list[str], list[str]]:
    """Render only the user-selected sections, with a scope notice listing
    what was omitted. Used when the upload flow lets the user explicitly
    pick which sections to send to the reviewer.

    Returns (text, included_headings, omitted_headings).

    Unlike render_paper_text:
      - No per-section soft cap — chosen sections are emitted in FULL.
      - No prioritized re-ordering — sections appear in document order.
      - Title + abstract are ALWAYS included regardless of selection (we
        treat them as zero-cost paper identification).
      - The output contains a [REVIEW SCOPE] block instructing the model
        to restrict its review to the included sections and not speculate
        about omitted ones.

    Caller is responsible for verifying the result fits FAIR_INPUT_TOKENS;
    if it doesn't, _trim_to_tokens in _budget.py applies (and would warn
    the user via the API if blocked).
    """
    # Normalize: dedupe + clamp + sort to match document order.
    n_sections = len(paper.sections)
    selected = sorted({i for i in selected_section_ids if 0 <= i < n_sections})

    included = [paper.sections[i] for i in selected]
    omitted = [
        s for i, s in enumerate(paper.sections) if i not in selected
    ]

    # 1. Head — title + abstract (always).
    head_parts: list[str] = []
    if paper.title:
        head_parts.append(f"# Title\n{paper.title}")
    if paper.abstract:
        head_parts.append(f"# Abstract\n{paper.abstract}")
    head = "\n\n".join(head_parts)

    # 2. The scope notice — placed BEFORE the section bodies so models
    # encounter it early in the context. Wrapped in literal markers so
    # specialist models that weren't trained on this pattern still notice
    # the boundary.
    scope = _format_scope_notice(
        [s.heading for s in included],
        [s.heading for s in omitted],
    )

    # 3. Selected section bodies, in document order, FULL text.
    body = "\n\n".join(
        f"{'#' * max(1, s.level)} {s.heading}\n{s.text}" for s in included
    )

    text = "\n\n".join(p for p in (head, scope, body) if p)
    return text, [s.heading for s in included], [s.heading for s in omitted]


def _format_scope_notice(
    included_headings: list[str], omitted_headings: list[str]
) -> str:
    """Literal text block embedded in canonicalText so every adapter —
    including fine-tuned specialists — sees the same scope instructions."""
    inc = "\n".join(f"  - {h}" for h in included_headings) or "  - (none)"
    omt = "\n".join(f"  - {h}" for h in omitted_headings) or "  - (none — full paper provided)"
    return (
        "[REVIEW SCOPE — IMPORTANT]\n"
        "This paper has been shared with you for a SCOPED REVIEW. You have\n"
        "access to the following sections in their entirety:\n"
        f"{inc}\n"
        "\n"
        "The following sections EXIST in the original paper but were\n"
        "intentionally NOT shared with you:\n"
        f"{omt}\n"
        "\n"
        "Instructions:\n"
        "  1. Review ONLY the included sections. Do not speculate about\n"
        "     omitted content.\n"
        "  2. Do not penalize the paper for material that is not shown —\n"
        "     it exists, just outside your scope.\n"
        "  3. If a claim or strength/weakness would depend on out-of-scope\n"
        "     content, write \"out of scope for this review\" instead of\n"
        "     guessing.\n"
        "[/REVIEW SCOPE]"
    )


def render_paper_text(paper: ParsedPaper, max_chars: int = 12000) -> str:
    """Render a ParsedPaper as a single prompt-ready string within max_chars.

    Drops body sections (and finally, as a last resort, hard-cuts the
    result) rather than dropping title/abstract/conclusion. Guarantees
    ``len(return) <= max_chars``.
    """
    # 1. Head — title + abstract.
    head_parts: list[str] = []
    if paper.title:
        head_parts.append(f"# Title\n{paper.title}")
    if paper.abstract:
        head_parts.append(f"# Abstract\n{paper.abstract}")
    head = "\n\n".join(head_parts)

    # 2. Split sections into "conclusion-like" vs body.
    conclusions = [s for s in paper.sections if _is_conclusion(s.heading)]
    body = [s for s in paper.sections if not _is_conclusion(s.heading)]
    conclusion_text = "\n\n".join(
        f"# {s.heading}\n{s.text}" for s in conclusions
    )

    # 3. Figure out the body budget. Reserve room for the head, the
    # conclusion, and a small slack for joining whitespace + appendices.
    appendix_refs = _format_references(paper)
    appendix_caps = _format_captions(paper)
    appendices_full = "\n\n".join(p for p in (appendix_refs, appendix_caps) if p)

    SEPARATOR = "\n\n"
    fixed_overhead = (
        len(head)
        + len(conclusion_text)
        + len(appendices_full)
        + 4 * len(SEPARATOR)
    )
    body_budget = max(0, max_chars - fixed_overhead)

    # 4. Pack body sections in order until the budget is full.
    body_chunks: list[str] = []
    used = 0
    for s in body:
        chunk = f"# {s.heading}\n{s.text}"
        # +len(SEPARATOR) accounts for the join between sections.
        next_len = used + len(chunk) + (len(SEPARATOR) if body_chunks else 0)
        if next_len <= body_budget:
            body_chunks.append(chunk)
            used = next_len
            continue
        # Section won't fit whole — if there's still room for a useful
        # head + truncation marker, include a partial slice. Otherwise stop.
        remaining = body_budget - used - (len(SEPARATOR) if body_chunks else 0)
        if remaining > 300:
            partial = chunk[: remaining - len("\n[… section truncated]")]
            body_chunks.append(partial + "\n[… section truncated]")
        break
    body_text = SEPARATOR.join(body_chunks)

    # 5. Stitch the pieces. If the result overshoots (defensive — shouldn't
    # happen given the budget calc), drop appendices first, then hard-cut.
    pieces = [head, body_text, conclusion_text, appendices_full]
    out = SEPARATOR.join(p for p in pieces if p)
    if len(out) > max_chars:
        out = SEPARATOR.join(p for p in (head, body_text, conclusion_text) if p)
    if len(out) > max_chars:
        out = out[:max_chars]
    return out
