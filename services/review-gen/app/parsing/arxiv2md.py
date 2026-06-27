"""arxiv2md-backed parser.

Fast-path for the case where the user supplies an arXiv ID or URL
instead of uploading a PDF. Calls timf34's hosted arxiv2md.org service
which converts arXiv's structured HTML to markdown, then we break that
markdown into the same ParsedPaper shape the adapters / judge already
consume.

Why arxiv2md and not arXiv HTML directly:
  - timf34's service already strips TOC/citations/refs by default,
    handles MathML→LaTeX, and keeps tables. Reimplementing that is
    extra code for a fast-path that may stay niche.

Limitations vs the Chandra PDF path:
  - Only works for arXiv papers that have HTML rendering (newer ones).
  - Authors come from the arXiv metadata API, not arxiv2md.
  - Figures/tables aren't returned as structured records — we leave
    those lists empty for now; the adapters tolerate that.
"""
from __future__ import annotations

import logging
import os
import re
from xml.etree import ElementTree as ET

import httpx

from app.schemas import ParsedPaper, ParsedReference, ParsedSection

logger = logging.getLogger("review-gen.parsing.arxiv2md")

# The public arxiv2md.org service went offline 2026-06-27 (TCP timeouts).
# We self-host the same FastAPI app on Cloud Run (services/cloudrun/arxiv2md/)
# and default to that URL. Override with the ARXIV2MD_BASE env var if we
# ever flip back to the public service or move the deploy.
ARXIV2MD_BASE = os.environ.get(
    "ARXIV2MD_BASE",
    "https://reviewarena-arxiv2md-760031824692.europe-west3.run.app",
).rstrip("/")
ARXIV_API_BASE = "https://export.arxiv.org/api/query"

# arxiv2md.org has a 30 req/min/IP cap; pages can be slow on cold cache.
ARXIV2MD_TIMEOUT_S = 60.0
ARXIV_API_TIMEOUT_S = 15.0

# Atom namespace returned by export.arxiv.org/api/query.
ATOM_NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
}


class Arxiv2MdError(RuntimeError):
    """arxiv2md.org didn't return usable content."""


# ─── Public entry point ───────────────────────────────────────────────────


def parse_from_arxiv(url_or_id: str) -> ParsedPaper:
    """Convert an arXiv URL/ID into a ParsedPaper via arxiv2md.

    Raises Arxiv2MdError on failure so the caller can mark the paper
    PARSE_FAILED (same contract as parse_with_chandra).
    """
    arxiv_id = normalize_arxiv_id(url_or_id)
    if not arxiv_id:
        raise Arxiv2MdError(f"could not extract arXiv ID from {url_or_id!r}")

    content_doc = _fetch_arxiv2md(arxiv_id)
    title = (content_doc.get("title") or "").strip() or None
    md = content_doc.get("content") or ""
    if not md.strip():
        raise Arxiv2MdError("arxiv2md returned empty content")

    abstract, sections, references = _split_markdown(md)

    # Authors + abstract (if missing) come from arXiv's own metadata API.
    # Best-effort: a failure here just leaves authors empty.
    try:
        meta = _fetch_arxiv_metadata(arxiv_id)
        authors = meta.get("authors") or []
        if not abstract:
            abstract = meta.get("abstract")
    except Exception as e:  # noqa: BLE001 — non-fatal enrichment
        logger.warning("arxiv metadata fetch failed for %s: %s", arxiv_id, e)
        authors = []

    return ParsedPaper(
        title=title,
        abstract=abstract,
        authors=authors,
        sections=sections,
        figures=[],
        tables=[],
        references=references,
        pageCount=None,
        source="arxiv2md",
    )


# ─── Helpers ───────────────────────────────────────────────────────────────


_ARXIV_ID_RE = re.compile(
    r"(?:arxiv\.org/(?:abs|pdf|html)/)?"
    r"(?P<id>\d{4}\.\d{4,5}(?:v\d+)?|[a-z\-]+(?:\.[A-Z]{2})?/\d{7}(?:v\d+)?)",
    re.IGNORECASE,
)


def normalize_arxiv_id(url_or_id: str) -> str | None:
    """Pull a canonical arXiv ID out of common URL/ID shapes."""
    s = (url_or_id or "").strip()
    if not s:
        return None
    # Strip trailing .pdf, query strings, fragments.
    s = re.sub(r"\.pdf(\?.*)?$", "", s, flags=re.IGNORECASE)
    s = s.split("?")[0].split("#")[0]
    m = _ARXIV_ID_RE.search(s)
    if not m:
        return None
    # Strip version suffix — arxiv2md doesn't need it and the latest is fine.
    return re.sub(r"v\d+$", "", m.group("id"))


def _fetch_arxiv2md(arxiv_id: str) -> dict:
    """Call arxiv2md.org/api/json. We ask it to keep refs so we can parse
    them into ParsedReference rows; citations/toc stay stripped (defaults)."""
    url = f"{ARXIV2MD_BASE}/api/json"
    params = {"url": arxiv_id, "remove_refs": "false"}
    try:
        with httpx.Client(timeout=ARXIV2MD_TIMEOUT_S) as client:
            resp = client.get(url, params=params)
    except httpx.HTTPError as e:
        raise Arxiv2MdError(f"arxiv2md.org unreachable: {e}") from e
    if resp.status_code == 429:
        raise Arxiv2MdError("arxiv2md.org rate limit (30 req/min/IP) hit")
    if resp.status_code != 200:
        raise Arxiv2MdError(f"arxiv2md.org {resp.status_code}: {resp.text[:200]}")
    try:
        return resp.json()
    except ValueError as e:
        raise Arxiv2MdError(f"arxiv2md.org returned non-JSON: {e}") from e


def _fetch_arxiv_metadata(arxiv_id: str) -> dict:
    """Hit arXiv's own Atom API for authors + abstract. Free, no auth."""
    params = {"id_list": arxiv_id, "max_results": 1}
    with httpx.Client(timeout=ARXIV_API_TIMEOUT_S) as client:
        resp = client.get(ARXIV_API_BASE, params=params)
    resp.raise_for_status()
    root = ET.fromstring(resp.content)
    entry = root.find("atom:entry", ATOM_NS)
    if entry is None:
        return {}
    authors: list[str] = []
    for a in entry.findall("atom:author/atom:name", ATOM_NS):
        if a.text:
            authors.append(a.text.strip())
    summary_el = entry.find("atom:summary", ATOM_NS)
    abstract = (summary_el.text or "").strip() if summary_el is not None else None
    abstract = re.sub(r"\s+", " ", abstract) if abstract else None
    return {"authors": authors, "abstract": abstract}


# ─── Markdown → sections ──────────────────────────────────────────────────


_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)


def _split_markdown(md: str) -> tuple[str | None, list[ParsedSection], list[ParsedReference]]:
    """Walk the markdown by `#`-level headings, emit sections + references.

    arxiv2md output looks like:
        ## Abstract
        ... text ...
        ## 1 Introduction
        ... text ...
        ## References
        - [1] Author, Title, Year
        - [2] ...

    The paper title is NOT in the markdown — it's returned as a separate
    JSON field (`title`) by arxiv2md, so we don't need to filter it here.
    Every `##`/`###` heading is a real section. The one matching
    /abstract/i is hoisted out as the `abstract` field; refs go into the
    references list.
    """
    headings = list(_HEADING_RE.finditer(md))
    if not headings:
        return None, [], []

    abstract: str | None = None
    sections: list[ParsedSection] = []
    references: list[ParsedReference] = []

    # Walk every heading — arxiv2md doesn't emit `# Title`, so the first
    # heading is already a real section (usually `## Abstract`).
    for i, h in enumerate(headings):
        level = len(h.group(1))
        heading = h.group(2).strip()
        body_start = h.end()
        body_end = headings[i + 1].start() if i + 1 < len(headings) else len(md)
        body = md[body_start:body_end].strip()

        low = heading.lower()
        if "abstract" in low and not abstract:
            abstract = _strip_md(body)
            continue
        if _is_references_heading(low):
            references = _parse_refs_block(body)
            continue
        # Cap heading level at 6 for the ParsedSection schema.
        sections.append(
            ParsedSection(
                heading=heading,
                level=min(6, max(1, level)),
                text=_strip_md(body),
            )
        )
    return abstract, sections, references


def _is_references_heading(low: str) -> bool:
    return any(k in low for k in ("references", "bibliography", "cited works"))


def _strip_md(s: str) -> str:
    """Remove markdown-only adornments that bloat token counts without
    adding info (image embeds, link bracket noise). Keep math + tables."""
    # Drop image lines.
    s = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", s)
    # Collapse [text](url) → text.
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s)
    # Collapse multiple blank lines.
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def _parse_refs_block(body: str) -> list[ParsedReference]:
    """Pull individual references out of a markdown bibliography block.

    arxiv2md tends to emit refs either as a numbered list (`1.`, `[1]`) or
    bullet list (`-`, `*`). We split on those leaders; whatever survives is
    treated as one raw reference line.
    """
    out: list[ParsedReference] = []
    # Normalize line breaks; strip image lines.
    body = _strip_md(body)
    # Split on lines starting with a list marker.
    lines = re.split(r"\n(?=\s*(?:\d+\.|\[\d+\]|[-*])\s)", body)
    for line in lines:
        line = line.strip()
        if not line:
            continue
        # Strip the leader.
        line = re.sub(r"^\s*(?:\d+\.|\[\d+\]|[-*])\s+", "", line).strip()
        if not line:
            continue
        # Year heuristic — first 4-digit number that looks like a year.
        year_match = re.search(r"\b(19|20)\d{2}\b", line)
        year = int(year_match.group()) if year_match else None
        out.append(ParsedReference(raw=line, title=None, authors=None, year=year))
    return out
