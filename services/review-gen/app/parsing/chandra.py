"""Chandra OCR-2 PDF parser — via Datalab's hosted /convert API.

Datalab (https://datalab.to) is the company that built both Marker and
Chandra. They expose a hosted endpoint that runs the same Chandra OCR-2
model we tried to self-host on Modal — except they handle the GPU, the
weights, the cold start, and the vLLM runtime. We just POST a PDF and
poll for the result.

Why hosted, not Modal:
  - Cold-start: their fleet is warm; we'd pay 3-5 min per first request.
  - Cost: Datalab's per-page price is competitive with the per-hour
    A100 cost we'd otherwise burn idling.
  - Operability: their service has no `_IncludedRouter` middleware
    bug. We don't have to patch vendor packages.

API shape (https://documentation.datalab.to/api-reference/convert-document):
  - POST /api/v1/convert     → returns {request_id, request_check_url}
  - GET  {request_check_url} → poll until status == "complete"
  - Auth header: X-API-Key
  - Default `/convert` (no `mode` override) is the Chandra pipeline —
    confirmed empirically: passing `mode=accurate` shows up in the
    Datalab dashboard as request_type="marker high accuracy" (i.e. it
    selects Marker, not Chandra). Plain `/convert` shows as
    request_type="convert" which is what we want.
"""
from __future__ import annotations

import logging
import os
import re
import time

import httpx

from app.schemas import ParsedPaper, ParsedReference, ParsedSection

logger = logging.getLogger("review-gen.parsing.chandra")

DATALAB_CONVERT_URL = "https://www.datalab.to/api/v1/convert"

# Per-request total timeout. Datalab parses an 8-page paper in ~20-40s
# warm; we allow generous headroom for queue + larger papers.
CHANDRA_TIMEOUT_S = 300.0

# Polling cadence. Datalab returns immediately with a request_id; we
# GET the check URL until status="complete". 2s is a polite floor;
# more frequent polling won't speed up the underlying parse.
_POLL_INTERVAL_S = 2.0
_POLL_DEADLINE_S = 280.0  # leave 20s headroom before CHANDRA_TIMEOUT_S


class ChandraError(RuntimeError):
    """Datalab /convert did not return usable markdown."""


def chandra_api_key() -> str:
    """API key for datalab.to. .strip() defends against pasted whitespace."""
    return os.environ.get("CHANDRA_API_KEY", "").strip()


def _auth_headers() -> dict:
    key = chandra_api_key()
    if not key:
        raise ChandraError("CHANDRA_API_KEY not configured")
    return {"X-API-Key": key}


def parse_with_chandra(
    pdf_bytes: bytes,
    filename: str = "paper.pdf",
    *,
    method: str | None = None,  # accepted for backward-compat, ignored
) -> ParsedPaper:
    """POST the PDF to Datalab /convert, poll until complete, return
    ParsedPaper. Raises ChandraError on any non-recoverable failure so
    the Node side can mark the paper PARSE_FAILED with a useful message.

    `method` is ignored — Datalab abstracts the underlying engine behind
    the `mode` parameter. We always use `mode=accurate` (Chandra).
    """
    if not pdf_bytes:
        raise ChandraError("empty PDF bytes")

    files = {
        # Datalab inspects the filename's extension to pick a parser
        # path; force ".pdf" so it never falls back to a text/image route.
        "file": (filename if filename.endswith(".pdf") else "paper.pdf",
                 pdf_bytes,
                 "application/pdf"),
    }
    data = {
        # NO `mode` override — default routes through Datalab's
        # "convert" pipeline (Chandra). `mode=accurate` confusingly
        # routes through Marker high-accuracy, not Chandra.
        # We only want markdown for downstream LLM judges. Asking for
        # html/json/chunks would waste tokens in their response.
        "output_format": "markdown",
        # We don't surface figures yet; skipping extraction is faster
        # and avoids a big base64 image blob in the response.
        "disable_image_extraction": "true",
        # Optimize markdown for LLM consumption (collapses redundant
        # whitespace, omits some adornments that don't carry meaning).
        "token_efficient_markdown": "true",
    }

    with httpx.Client(timeout=CHANDRA_TIMEOUT_S) as client:
        # Submit.
        try:
            submit = client.post(
                DATALAB_CONVERT_URL,
                headers=_auth_headers(),
                files=files,
                data=data,
            )
        except httpx.HTTPError as e:
            raise ChandraError(f"datalab /convert unreachable: {e}") from e

        if submit.status_code != 200:
            raise ChandraError(
                f"datalab /convert HTTP {submit.status_code}: "
                f"{submit.text[:300]}"
            )

        try:
            submit_body = submit.json()
        except ValueError as e:
            raise ChandraError(f"datalab /convert returned non-JSON: {e}") from e

        if not submit_body.get("success"):
            raise ChandraError(
                f"datalab /convert rejected request: "
                f"{submit_body.get('error') or submit_body}"
            )

        check_url = submit_body.get("request_check_url")
        request_id = submit_body.get("request_id")
        if not check_url:
            raise ChandraError(
                f"datalab /convert response missing request_check_url: "
                f"{submit_body}"
            )
        logger.info("datalab /convert submitted (request_id=%s)", request_id)

        # Poll. The check URL is fully-qualified — Datalab gives us the
        # complete URL, no need to construct one from request_id.
        deadline = time.time() + _POLL_DEADLINE_S
        last_status: str = "?"
        while time.time() < deadline:
            try:
                poll = client.get(check_url, headers=_auth_headers())
            except httpx.HTTPError as e:
                raise ChandraError(
                    f"datalab poll unreachable (request_id={request_id}): {e}"
                ) from e

            if poll.status_code != 200:
                raise ChandraError(
                    f"datalab poll HTTP {poll.status_code} "
                    f"(request_id={request_id}): {poll.text[:300]}"
                )
            try:
                poll_body = poll.json()
            except ValueError as e:
                raise ChandraError(
                    f"datalab poll returned non-JSON "
                    f"(request_id={request_id}): {e}"
                ) from e

            status = poll_body.get("status") or "?"
            last_status = status
            if status == "complete":
                if not poll_body.get("success", True):
                    raise ChandraError(
                        f"datalab parse failed (request_id={request_id}): "
                        f"{poll_body.get('error') or 'unknown'}"
                    )
                markdown = poll_body.get("markdown") or ""
                if not markdown.strip():
                    raise ChandraError(
                        f"datalab returned empty markdown "
                        f"(request_id={request_id})"
                    )
                # Datalab returns these alongside markdown — useful for
                # debugging and cost tracking. We embed them in metadata
                # so the eval harness can compare runs.
                metadata = {
                    "source": "datalab-chandra",
                    "request_id": request_id,
                    "page_count": poll_body.get("page_count"),
                    "parse_quality_score": poll_body.get("parse_quality_score"),
                    "runtime": poll_body.get("runtime"),
                    "cost_breakdown": poll_body.get("cost_breakdown"),
                    "versions": poll_body.get("versions"),
                }
                return _markdown_to_parsed_paper(
                    markdown,
                    metadata,
                    source="chandra",
                )
            # Any non-"complete" status is treated as still-processing.
            # If Datalab ever surfaces an explicit "failed" we'll catch
            # it via the success=False branch above on the next poll.
            time.sleep(_POLL_INTERVAL_S)

        raise ChandraError(
            f"datalab parse did not complete within "
            f"{_POLL_DEADLINE_S:.0f}s (last status={last_status}, "
            f"request_id={request_id})"
        )


# ─── Markdown → ParsedPaper ───────────────────────────────────────────────
# Chandra emits standard `# Title / ## Section` markdown — we split on
# heading levels into the canonical ParsedPaper shape so downstream
# review code stays parser-agnostic.

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)


def _markdown_to_parsed_paper(
    md: str,
    metadata: dict,
    *,
    source: str = "chandra",
) -> ParsedPaper:
    """Split Chandra markdown by `#`-level headings into ParsedPaper.

    Expected shape:
        # Paper Title
        <author lines / affiliations / abstract>
        ## 1. Introduction
        ...
        ## References
        - [1] ...

    We promote the first heading as title, find the abstract heuristically
    (first `## Abstract` or text before first `##` heading), pull
    references out, and treat every other `##`/`###` section as a body
    ParsedSection. Math + tables already live inside the section text as
    inline LaTeX / pipe-tables; we keep them verbatim.
    """
    headings = list(_HEADING_RE.finditer(md))
    title: str | None = None
    abstract: str | None = None
    sections: list[ParsedSection] = []
    references: list[ParsedReference] = []

    if headings:
        title = _clean(headings[0].group(2))

    for i, h in enumerate(headings[1:], start=1):
        level = len(h.group(1))
        heading = _clean(h.group(2))
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
        sections.append(
            ParsedSection(
                heading=heading,
                level=min(6, max(1, level)),
                text=_strip_md(body),
            )
        )

    if abstract is None and len(headings) >= 2:
        prelude = md[headings[0].end() : headings[1].start()].strip()
        if prelude:
            abstract = _strip_md(prelude)[:3000]

    page_count = metadata.get("page_count") if isinstance(metadata, dict) else None
    if not isinstance(page_count, int):
        page_count = None

    return ParsedPaper(
        title=title,
        abstract=abstract,
        authors=[],
        sections=sections,
        figures=[],
        tables=[],
        references=references,
        pageCount=page_count,
        source=source,
    )


def _strip_md(s: str) -> str:
    """Trim markdown adornments that don't carry meaning for review prompts
    (image embeds, link bracket noise). Keep math and tables intact."""
    s = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", s)              # drop image embeds
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s)          # collapse [text](url)
    s = re.sub(r"\n{3,}", "\n\n", s)                         # squash blank runs
    return s.strip()


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def _is_references_heading(low: str) -> bool:
    return any(
        k in low
        for k in ("references", "bibliography", "works cited", "literature cited")
    )


def _parse_refs_block(body: str) -> list[ParsedReference]:
    """Split a bibliography section into individual references. Refs may
    appear as a markdown list (`- [1]`, `1.`) or one paragraph per ref."""
    body = _strip_md(body)
    parts = re.split(r"\n(?=\s*(?:\d+\.|\[\d+\]|[-*])\s)", body)
    out: list[ParsedReference] = []
    for raw in parts:
        line = raw.strip()
        if not line:
            continue
        line = re.sub(r"^\s*(?:\d+\.|\[\d+\]|[-*])\s+", "", line).strip()
        if not line:
            continue
        year_match = re.search(r"\b(19|20)\d{2}\b", line)
        year = int(year_match.group()) if year_match else None
        out.append(ParsedReference(raw=line, title=None, authors=None, year=year))
    return out
